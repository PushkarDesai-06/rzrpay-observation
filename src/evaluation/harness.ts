import { openDatabase, type Database } from "@/db/client";
import { SimulatedClock, MINUTE_MS } from "@/core/clock";
import { ProviderKind, RecoveryState } from "@/core/domain/enums";
import type { Paise } from "@/core/domain/money";
import type { RecoveryPolicy } from "@/core/policy/policy-config";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import type { RecoveryAgent } from "@/core/agent/recovery-agent";
import { SimulatedPaymentProvider } from "@/providers/simulated-provider";
import { OutboxNotifier } from "@/providers/notifier";
import { EventService } from "@/services/event-service";
import { RecoveryService } from "@/services/recovery-service";
import { MetricsService } from "@/services/metrics-service";
import { CaseRepository } from "@/db/repositories/case-repository";
import { CustomerRepository } from "@/db/repositories/customer-repository";
import { DecisionRepository } from "@/db/repositories/decision-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { PolicyRepository } from "@/db/repositories/policy-repository";
import type { MetricsSnapshot } from "@/core/metrics/metrics";
import type { Archetype, SyntheticCase } from "@/evaluation/dataset";

/**
 * Runs a whole batch of cases through the recovery loop, on a clock it drives
 * itself, and hands back what actually happened.
 *
 * The harness owns time and nothing else. It never decides an outcome, never
 * writes a case state and never touches the policy engine — it ingests the
 * failures, advances the simulated clock to the next moment the system asked to
 * be woken, and calls `tick()` until every case is closed. So a run measures
 * the system under test rather than the harness's opinion of it.
 */

export interface CaseOutcome {
  caseId: string;
  paymentId: string;
  archetype: Archetype;
  amountPaise: Paise;
  failureCode: string;
  finalState: RecoveryState;
  recovered: boolean;
  recoveredAmountPaise: Paise;
  hoursToRecovery: number | null;
  cycles: number;
  actionsExecuted: number;
  /** The actions that actually ran, in order. */
  actions: string[];
  /** Proposals the policy engine refused on this case. */
  policyBlocks: number;
  /** Which rules refused them, most recent last. */
  blockRules: string[];
  /** The rule that decided a terminal escalation or stop, when one did. */
  terminalRule: string | null;
  lastDecisionSource: string | null;
  lastReasoningSummary: string | null;
}

export interface ArmResult {
  /** Short identifier used as the column heading in the comparison. */
  arm: string;
  /** What actually decided, in words. Printed alongside every result. */
  decider: string;
  snapshot: MetricsSnapshot;
  outcomes: CaseOutcome[];
  /** Simulated hours the batch took from first detection to last closure. */
  simulatedHours: number;
  rounds: number;
  /** True if the loop was cut off before every case closed. */
  hitRoundLimit: boolean;
  openCasesAtEnd: number;
  /** Blocks attributable to the system-wide 24h cap, which is a batch-size artefact. */
  globalCapBlocks: number;
  /** Proposals the policy engine refused outright, leaving the case to wait. */
  genuineBlocks: number;
  /** Proposals the policy engine replaced with ESCALATE or STOP. Not refusals. */
  diversions: number;
}

export interface RunArmOptions {
  arm: string;
  decider: string;
  agent: RecoveryAgent;
  dataset: readonly SyntheticCase[];
  seed: number;
  startAt: Date;
  policy?: RecoveryPolicy;
  /** Keep the provider's simulated outages on. Off only for tests that need certainty. */
  simulateApiFailures?: boolean;
  /** Write to a real file instead of an in-memory database. */
  databasePath?: string;
  maxRounds?: number;
  onProgress?: (round: number, openCases: number) => void;
}

/** Safety net for the drive loop; a real batch closes long before this. */
const DEFAULT_MAX_ROUNDS = 2000;

export async function runArm(options: RunArmOptions): Promise<ArmResult> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;

  const db = openDatabase(options.databasePath ?? ":memory:");
  const clock = new SimulatedClock(options.startAt);
  const provider = new SimulatedPaymentProvider({
    seed: options.seed,
    clock,
    simulateApiFailures: options.simulateApiFailures ?? true,
  });
  const notifier = new OutboxNotifier(db, clock);

  const events = new EventService(db, clock);
  const recovery = new RecoveryService(db, options.agent, provider, notifier, clock, policy);
  const cases = new CaseRepository(db);
  const customers = new CustomerRepository(db);

  try {
    ingest(options.dataset, { events, customers, provider });

    let rounds = 0;
    let openCases = countOpen(cases);
    while (openCases > 0 && rounds < maxRounds) {
      rounds += 1;
      await recovery.tick();
      options.onProgress?.(rounds, openCases);

      openCases = countOpen(cases);
      if (openCases === 0) break;
      advanceToNextDueTime(cases, clock);
    }

    const startedAt = options.startAt.getTime();
    return {
      arm: options.arm,
      decider: options.decider,
      snapshot: new MetricsService(db, clock).snapshot(),
      outcomes: collectOutcomes(db, options.dataset),
      simulatedHours: (clock.now().getTime() - startedAt) / 3_600_000,
      rounds,
      hitRoundLimit: rounds >= maxRounds && openCases > 0,
      openCasesAtEnd: openCases,
      globalCapBlocks: countGlobalCapBlocks(db),
      ...countVerdicts(db),
    };
  } finally {
    db.close();
  }
}

/**
 * Load the batch.
 *
 * Customers are written before their failures are ingested, because a customer
 * with no history looks identical to a brand-new one and the agent would be
 * reasoning about a book that does not exist. `EventService` deliberately
 * preserves the counters of a customer it already knows, so this history
 * survives detection intact.
 */
function ingest(
  dataset: readonly SyntheticCase[],
  deps: {
    events: EventService;
    customers: CustomerRepository;
    provider: SimulatedPaymentProvider;
  },
): void {
  for (const item of dataset) {
    deps.customers.upsert({
      id: item.customer.id,
      name: item.customer.name,
      email: item.customer.email,
      createdAt: item.customer.createdAt,
      lifetimeValuePaise: item.customer.lifetimeValuePaise,
      successfulPaymentsCount: item.customer.successfulPaymentsCount,
      failedPaymentsCount: item.customer.failedPaymentsCount,
      lastSuccessfulPaymentAt: item.customer.lastSuccessfulPaymentAt,
    });

    deps.events.ingestPaymentFailed({
      provider: ProviderKind.SIMULATED,
      paymentId: item.paymentId,
      customer: { id: item.customer.id, name: item.customer.name, email: item.customer.email },
      amountPaise: item.amountPaise,
      method: item.method,
      failureReasonRaw: item.failureReasonRaw,
      attemptNumber: item.attemptNumber,
      occurredAt: item.failedAt,
    });

    // Tell the provider what this payment failed on, so a retry of it is drawn
    // against the right odds rather than against UNKNOWN.
    deps.provider.registerFailedPayment(item.paymentId, item.failureCode);
  }
}

function countOpen(cases: CaseRepository): number {
  return cases.list({ limit: 10_000 }).filter((c) => c.closedAt === null).length;
}

/**
 * Jump to the next moment the system asked to be woken.
 *
 * Every open case carries the time it wants to be looked at again, so the
 * simulation can skip the dead time between interventions instead of stepping
 * through it. A case with nothing scheduled gets a short nudge so the loop
 * cannot stall on it.
 */
function advanceToNextDueTime(cases: CaseRepository, clock: SimulatedClock): void {
  const now = clock.now().getTime();
  let earliest: number | null = null;

  for (const item of cases.list({ limit: 10_000 })) {
    if (item.closedAt !== null) continue;
    const due = item.nextEvaluationAt?.getTime() ?? null;
    if (due === null || due <= now) return; // Something is due already; do not move time.
    if (earliest === null || due < earliest) earliest = due;
  }

  if (earliest === null) {
    clock.advanceMs(30 * MINUTE_MS);
    return;
  }
  clock.set(new Date(earliest));
}

function collectOutcomes(db: Database, dataset: readonly SyntheticCase[]): CaseOutcome[] {
  const cases = new CaseRepository(db);
  const decisions = new DecisionRepository(db);
  const actions = new ActionRepository(db);
  const policies = new PolicyRepository(db);

  const outcomes: CaseOutcome[] = [];
  for (const item of dataset) {
    const found = cases.findByPaymentId(item.paymentId);
    if (!found) continue;

    const executed = actions.forCase(found.id);
    const latest = decisions.latestForCase(found.id);
    const evaluations = policies.forCase(found.id);
    const blocked = evaluations.filter((e) => !e.approved);
    const decidingRule = [...evaluations]
      .reverse()
      .find((e) => e.effectiveAction === "ESCALATE" || e.effectiveAction === "STOP");

    outcomes.push({
      caseId: found.id,
      paymentId: item.paymentId,
      archetype: item.archetype,
      amountPaise: found.amountPaise,
      failureCode: item.failureCode,
      finalState: found.state,
      recovered: found.state === RecoveryState.RECOVERED,
      // Only ever the confirmed figure the outcome tracker wrote.
      recoveredAmountPaise: found.recoveredAmountPaise ?? 0,
      hoursToRecovery: found.recoveredAt
        ? (found.recoveredAt.getTime() - found.openedAt.getTime()) / 3_600_000
        : null,
      cycles: found.cycleCount,
      actionsExecuted: executed.length,
      actions: executed.map((a) => a.action),
      policyBlocks: blocked.length,
      blockRules: blocked.map((e) => e.ruleCode),
      terminalRule: decidingRule?.ruleCode ?? null,
      lastDecisionSource: latest?.source ?? null,
      lastReasoningSummary: latest?.reasoningSummary ?? null,
    });
  }
  return outcomes;
}

/**
 * Split unapproved verdicts into the two things they actually are.
 *
 * A refused proposal and a diverted one are recorded identically as
 * `approved = 0`, but they mean opposite things: a refusal leaves the case
 * waiting with nothing done, while a diversion is the policy engine choosing
 * ESCALATE or STOP itself. Only a refusal sets `effective_action` to NULL, so
 * that column separates them exactly. Reporting the two as one number would
 * make every strategy look far more obstructed than it was.
 */
function countVerdicts(db: Database): { genuineBlocks: number; diversions: number } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN effective_action IS NULL THEN 1 ELSE 0 END), 0) AS blocks,
         COALESCE(SUM(CASE WHEN effective_action IS NOT NULL THEN 1 ELSE 0 END), 0) AS diversions
       FROM policy_evaluations WHERE approved = 0`,
    )
    .get() as { blocks: number; diversions: number };
  return { genuineBlocks: Number(row.blocks), diversions: Number(row.diversions) };
}

function countGlobalCapBlocks(db: Database): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM policy_evaluations WHERE rule_code = 'GLOBAL_ACTION_CAP'`)
    .get() as { n: number };
  return Number(row.n);
}
