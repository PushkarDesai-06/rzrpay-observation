/**
 * Walking skeleton: one failed payment carried end to end.
 *
 * Detect -> analyse -> diagnose -> decide -> validate -> act -> observe -> measure.
 * Runs on the simulated provider and a simulated clock so the 72-hour recovery
 * window plays out in a few seconds.
 */
import { loadEnvFile } from "@/config/load-env";
import { openDatabase } from "@/db/client";
import { SimulatedClock } from "@/core/clock";
import { loadConfig, selectAgent } from "@/config";
import { SimulatedPaymentProvider } from "@/providers/simulated-provider";
import { OutboxNotifier } from "@/providers/notifier";
import { EventService } from "@/services/event-service";
import { RecoveryService } from "@/services/recovery-service";
import { CaseRepository } from "@/db/repositories/case-repository";
import { DecisionRepository } from "@/db/repositories/decision-repository";
import { PolicyRepository } from "@/db/repositories/policy-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";
import { OutboxRepository } from "@/db/repositories/outbox-repository";
import { FailureCode, PaymentMethod, ProviderKind, RecoveryState } from "@/core/domain/enums";
import { formatINR } from "@/core/domain/money";
import { normaliseFailureReason } from "@/core/domain/failure-codes";

// Read .env before anything inspects process.env.
loadEnvFile();

const config = loadConfig();
const START = new Date("2026-08-30T09:00:00.000Z");

const db = openDatabase(":memory:");
const clock = new SimulatedClock(START);
const provider = new SimulatedPaymentProvider({
  seed: config.simulationSeed,
  clock,
  simulateApiFailures: false,
});
const notifier = new OutboxNotifier(db, clock);
const { agent, description: deciderDescription } = selectAgent(config);

const events = new EventService(db, clock);
const recovery = new RecoveryService(db, agent, provider, notifier, clock, config.policy);
const cases = new CaseRepository(db);
const decisions = new DecisionRepository(db);
const policies = new PolicyRepository(db);
const actions = new ActionRepository(db);
const audit = new AuditRepository(db);
const outbox = new OutboxRepository(db);

const rule = (label = "") =>
  console.log(`\n${"─".repeat(72)}${label ? `\n${label}` : ""}`);

async function main(): Promise<void> {
  console.log("AI Revenue Recovery Agent — walking skeleton");
  console.log(`Decider:  ${deciderDescription}`);
  console.log(`Provider: simulated (no real money moves)`);
  console.log(`Clock:    simulated, starting ${START.toISOString()}`);

  // ---- 1. A revenue-loss event occurs ------------------------------------
  rule("1. DETECT — a payment fails");
  const reason = "Issuer bank unavailable, please retry";
  const ingest = events.ingestPaymentFailed({
    provider: ProviderKind.SIMULATED,
    paymentId: "pay_demo_001",
    customer: { id: "cust_demo_001", name: "Asha Menon", email: "asha@example.com" },
    amountPaise: 249900,
    method: PaymentMethod.CARD,
    failureReasonRaw: reason,
  });
  provider.registerFailedPayment("pay_demo_001", normaliseFailureReason(reason));

  console.log(`  Payment      pay_demo_001  ${formatINR(249900)}  CARD`);
  console.log(`  Reason       "${reason}"  ->  ${normaliseFailureReason(reason)}`);
  console.log(`  Case         ${ingest.case.id}  state=${ingest.case.state}`);
  console.log(`  Revenue at risk: ${formatINR(events.revenueAtRiskPaise())}`);

  // Prove idempotency in the demo itself.
  const duplicate = events.ingestPaymentFailed({
    provider: ProviderKind.SIMULATED,
    paymentId: "pay_demo_001",
    customer: { id: "cust_demo_001", name: "Asha Menon", email: "asha@example.com" },
    amountPaise: 249900,
    method: PaymentMethod.CARD,
    failureReasonRaw: reason,
  });
  console.log(`  Duplicate event -> accepted=${duplicate.accepted}, cases in system=${cases.list().length}`);

  const caseId = ingest.case.id;

  // ---- 2-7. Run the loop until the case reaches a terminal state ----------
  rule("2. THE LOOP — analyse, decide, validate, act, observe");

  let round = 0;
  while (round < 25) {
    round += 1;
    const before = cases.requireById(caseId);
    if (before.closedAt !== null) break;

    const tick = await recovery.tick();

    for (const cycle of tick.cycles) {
      const decision = decisions.latestForCase(cycle.caseId);
      console.log(`\n  ── cycle ${cycle.cycle} @ ${clock.now().toISOString()}`);
      console.log(`     diagnosis      ${decision?.diagnosis}  (${decision?.recoverability}, confidence ${decision?.confidence.toFixed(2)})`);
      console.log(`     source         ${cycle.decisionSource}`);
      console.log(`     why            ${decision?.reasoningSummary}`);
      console.log(`     proposed       ${cycle.proposedAction}`);
      console.log(`     policy         ${cycle.policyOutcome} [${cycle.policyRule}]${cycle.overridden ? "  ← OVERRIDDEN" : ""}`);
      console.log(`                    ${cycle.policyReason}`);
      if (cycle.execution) {
        console.log(`     executed       ${cycle.execution.action} via ${cycle.execution.provider} -> ${cycle.execution.status}`);
        if (cycle.execution.externalRef) console.log(`     reference      ${cycle.execution.externalRef}`);
      }
      console.log(`     state          ${cycle.finalState}`);
    }

    if (tick.recovered > 0) {
      console.log(`\n  ── outcome observed @ ${clock.now().toISOString()}`);
      console.log(`     CONFIRMED payment: ${formatINR(tick.recoveredAmountPaise)} recovered`);
    }

    const after = cases.requireById(caseId);
    if (after.closedAt !== null) break;

    // Advance simulated time to whenever the case next needs attention.
    const next = after.nextEvaluationAt;
    if (next && next.getTime() > clock.now().getTime()) {
      clock.set(next);
    } else {
      clock.advanceMinutes(30);
    }
  }

  // ---- 8. Measure --------------------------------------------------------
  const final = cases.requireById(caseId);

  rule("3. AUDIT TRAIL — every step, in order");
  for (const entry of audit.forCase(caseId)) {
    console.log(`  ${entry.at.toISOString()}  ${entry.actor.padEnd(18)} ${entry.event}`);
  }

  rule("4. STATE TIMELINE");
  console.log(`  DETECTED`);
  for (const t of cases.timeline(caseId)) {
    console.log(`     ↓ ${t.trigger}\n  ${t.toState}`);
  }

  rule("5. MEASURE");
  const recovered = final.state === RecoveryState.RECOVERED;
  console.log(`  Final state        ${final.state}`);
  console.log(`  Decisions made     ${decisions.forCase(caseId).length}`);
  console.log(`  Policy checks      ${policies.forCase(caseId).length} (${policies.countBlocked()} blocked)`);
  console.log(`  Actions executed   ${actions.forCase(caseId).length}`);
  console.log(`  Messages sent      ${outbox.forCase(caseId).length} (transport: outbox — not delivered to a real inbox)`);
  console.log(`  Revenue at risk    ${formatINR(events.revenueAtRiskPaise())}`);
  console.log(`  Revenue recovered  ${formatINR(final.recoveredAmountPaise ?? 0)}`);
  if (recovered && final.recoveredAt) {
    const hours = (final.recoveredAt.getTime() - final.openedAt.getTime()) / 3_600_000;
    console.log(`  Time to recovery   ${hours.toFixed(1)}h (simulated)`);
  }
  console.log("");

  db.close();
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exitCode = 1;
});
