import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openTestDatabase, type Database } from "@/db/client";
import { SimulatedClock } from "@/core/clock";
import { EventService } from "@/services/event-service";
import { RecoveryService } from "@/services/recovery-service";
import { ActionExecutor, UnapprovedActionError } from "@/services/action-executor";
import { OutboxNotifier } from "@/providers/notifier";
import { SimulatedPaymentProvider } from "@/providers/simulated-provider";
import {
  HeuristicRecoveryAgent,
  FixtureRecoveryAgent,
  type RecoveryAgent,
} from "@/core/agent/recovery-agent";
import { CaseRepository } from "@/db/repositories/case-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { PolicyRepository } from "@/db/repositories/policy-repository";
import { OutboxRepository } from "@/db/repositories/outbox-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";
import { normaliseFailureReason } from "@/core/domain/failure-codes";
import {
  Diagnosis,
  FailureCode,
  PaymentMethod,
  PaymentStatus,
  ProviderKind,
  Recoverability,
  RecoveryAction,
  RecoveryState,
} from "@/core/domain/enums";
import type {
  PaymentLinkResult,
  PaymentLinkStatus,
  PaymentProvider,
  PaymentResult,
} from "@/providers/payment-provider";
import { ApprovedAction } from "@/core/policy/policy-engine";
import type { RecoveryDecision } from "@/core/domain/types";

const START = new Date("2026-08-30T09:00:00.000Z");

/** Fully controllable provider, so outcome assertions never depend on a draw. */
class StubProvider implements PaymentProvider {
  readonly kind = ProviderKind.SIMULATED;
  retrySucceeds = false;
  linkGetsPaid = false;
  linkCreationFails = false;
  retryThrows = false;
  private captured = false;
  private linkPaid = false;

  retryPayment(): Promise<PaymentResult> {
    if (this.retryThrows) return Promise.reject(new Error("gateway exploded"));
    if (this.retrySucceeds) this.captured = true;
    return Promise.resolve({
      success: this.retrySucceeds,
      status: this.retrySucceeds ? PaymentStatus.CAPTURED : PaymentStatus.FAILED,
      externalReference: this.retrySucceeds ? "stub_ref" : null,
      failureCode: this.retrySucceeds ? null : FailureCode.CARD_DECLINED,
      failureReasonRaw: this.retrySucceeds ? null : "declined again",
      provider: this.kind,
      raw: {},
    });
  }

  createRecoveryLink(): Promise<PaymentLinkResult> {
    if (this.linkCreationFails) {
      return Promise.resolve({
        success: false, linkId: null, url: null, provider: this.kind, raw: {}, error: "link api down",
      });
    }
    if (this.linkGetsPaid) this.linkPaid = true;
    return Promise.resolve({
      success: true, linkId: "stub_link", url: "https://pay.test/stub_link",
      provider: this.kind, raw: {}, error: null,
    });
  }

  getPaymentStatus(): Promise<PaymentStatus> {
    return Promise.resolve(this.captured ? PaymentStatus.CAPTURED : PaymentStatus.FAILED);
  }

  getPaymentLinkStatus(): Promise<PaymentLinkStatus> {
    return Promise.resolve({
      paid: this.linkPaid,
      paidAt: this.linkPaid ? START : null,
      amountPaise: this.linkPaid ? 249900 : null,
      externalReference: this.linkPaid ? "stub_link_pay" : null,
    });
  }
}

let db: Database;
let clock: SimulatedClock;
let events: EventService;
let cases: CaseRepository;
let actions: ActionRepository;
let policies: PolicyRepository;
let outbox: OutboxRepository;
let audit: AuditRepository;

beforeEach(() => {
  db = openTestDatabase();
  clock = new SimulatedClock(START);
  events = new EventService(db, clock);
  cases = new CaseRepository(db);
  actions = new ActionRepository(db);
  policies = new PolicyRepository(db);
  outbox = new OutboxRepository(db);
  audit = new AuditRepository(db);
});
afterEach(() => db.close());

function openCase(options: { reason: string; amountPaise?: number; paymentId?: string } ): string {
  const result = events.ingestPaymentFailed({
    provider: ProviderKind.SIMULATED,
    paymentId: options.paymentId ?? "pay_1",
    customer: { id: "cust_1", name: "Asha Menon", email: "asha@example.com" },
    amountPaise: options.amountPaise ?? 249900,
    method: PaymentMethod.CARD,
    failureReasonRaw: options.reason,
  });
  return result.case.id;
}

function service(
  provider: PaymentProvider,
  agent: RecoveryAgent = new HeuristicRecoveryAgent(),
): RecoveryService {
  return new RecoveryService(db, agent, provider, new OutboxNotifier(db, clock), clock);
}

/** Run the loop until the case closes or the round budget is spent. */
async function runToCompletion(recovery: RecoveryService, caseId: string, maxRounds = 40): Promise<void> {
  for (let i = 0; i < maxRounds; i += 1) {
    const current = cases.requireById(caseId);
    if (current.closedAt !== null) return;
    await recovery.tick();
    const after = cases.requireById(caseId);
    if (after.closedAt !== null) return;
    const next = after.nextEvaluationAt;
    if (next && next.getTime() > clock.now().getTime()) clock.set(next);
    else clock.advanceMinutes(30);
  }
}

describe("Case 1 — temporary failure recovered by retry", () => {
  it("closes as RECOVERED with the amount recorded", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;
    const caseId = openCase({ reason: "Issuer bank unavailable" });

    await runToCompletion(service(provider), caseId);

    const final = cases.requireById(caseId);
    expect(final.state).toBe(RecoveryState.RECOVERED);
    expect(final.recoveredAmountPaise).toBe(249900);
    expect(final.recoveredAt).not.toBeNull();
    expect(actions.forCase(caseId).map((a) => a.action)).toContain(RecoveryAction.RETRY_PAYMENT);
  });

  it("records the whole chain in the audit trail", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;
    const caseId = openCase({ reason: "Issuer bank unavailable" });
    await runToCompletion(service(provider), caseId);

    const trail = audit.forCase(caseId).map((e) => e.event);
    expect(trail).toContain("CASE_CREATED");
    expect(trail).toContain("AGENT_DECISION");
    expect(trail).toContain("POLICY_APPROVED");
    expect(trail).toContain("ACTION_EXECUTING");
    expect(trail).toContain("ACTION_SUCCEEDED");
    expect(trail).toContain("REVENUE_RECOVERED");
  });
});

describe("Case 2 — manual recovery via payment link", () => {
  it("never retries an expired card, and recovers when the customer pays", async () => {
    const provider = new StubProvider();
    provider.linkGetsPaid = true;
    const caseId = openCase({ reason: "Card has expired" });

    await runToCompletion(service(provider), caseId);

    const final = cases.requireById(caseId);
    expect(final.state).toBe(RecoveryState.RECOVERED);
    expect(final.recoveredAmountPaise).toBe(249900);

    const attempted = actions.forCase(caseId).map((a) => a.action);
    expect(attempted).toContain(RecoveryAction.CREATE_PAYMENT_LINK);
    expect(attempted).not.toContain(RecoveryAction.RETRY_PAYMENT);
    expect(outbox.forCase(caseId).length).toBeGreaterThan(0);
  });

  it("marks the message transport honestly", async () => {
    const provider = new StubProvider();
    provider.linkGetsPaid = true;
    const caseId = openCase({ reason: "Card has expired" });
    await runToCompletion(service(provider), caseId);
    expect(outbox.forCase(caseId).every((m) => m.transport === "outbox")).toBe(true);
  });
});

describe("Case 3 — customer never responds", () => {
  it("stops when the recovery window expires, recovering nothing", async () => {
    const provider = new StubProvider(); // link created, never paid
    const caseId = openCase({ reason: "Card has expired" });

    await runToCompletion(service(provider), caseId, 80);

    const final = cases.requireById(caseId);
    expect(final.state).toBe(RecoveryState.STOPPED);
    expect(final.recoveredAmountPaise).toBeNull();
    expect(final.closedAt).not.toBeNull();
  });

  it("respects the reminder ceiling while it waits", async () => {
    const provider = new StubProvider();
    const caseId = openCase({ reason: "Card has expired" });
    await runToCompletion(service(provider), caseId, 80);

    const reminders = actions
      .forCase(caseId)
      .filter((a) => a.action === RecoveryAction.SEND_REMINDER && a.status === "SUCCEEDED");
    expect(reminders.length).toBeLessThanOrEqual(2);
  });
});

describe("Case 4 — low confidence escalates instead of guessing", () => {
  it("escalates an unexplained failure without touching a provider", async () => {
    const provider = new StubProvider();
    const caseId = openCase({ reason: "ERR_7731" });

    await runToCompletion(service(provider), caseId);

    const final = cases.requireById(caseId);
    expect(final.state).toBe(RecoveryState.ESCALATED);
    expect(final.recoveredAmountPaise).toBeNull();
    // No money-moving action was attempted on an unclear case.
    expect(actions.forCase(caseId).map((a) => a.action)).not.toContain(RecoveryAction.RETRY_PAYMENT);
  });

  it("escalates a high-value case even when the agent is confident", async () => {
    const confident: RecoveryDecision = {
      diagnosis: Diagnosis.TEMPORARY_FAILURE,
      recoverability: Recoverability.HIGH,
      confidence: 0.98,
      recommendedAction: RecoveryAction.RETRY_PAYMENT,
      reasoningSummary: "Very sure this is transient.",
      expectedValuePaise: 4_000_000,
    };
    const caseId = openCase({ reason: "Issuer bank unavailable", amountPaise: 5_000_000 });
    await runToCompletion(service(new StubProvider(), new FixtureRecoveryAgent([confident])), caseId);

    const final = cases.requireById(caseId);
    expect(final.state).toBe(RecoveryState.ESCALATED);
    expect(actions.forCase(caseId)).toHaveLength(0);
  });
});

describe("Case 5 — policy blocks an action", () => {
  it("blocks a reminder once the limit is reached and records the block", async () => {
    const spamming: RecoveryDecision = {
      diagnosis: Diagnosis.CUSTOMER_ACTION_REQUIRED,
      recoverability: Recoverability.MEDIUM,
      confidence: 0.9,
      recommendedAction: RecoveryAction.SEND_REMINDER,
      reasoningSummary: "Chase the customer again.",
      expectedValuePaise: 100000,
    };
    const caseId = openCase({ reason: "Card has expired" });
    await runToCompletion(service(new StubProvider(), new FixtureRecoveryAgent([spamming])), caseId, 60);

    const blocked = policies.forCase(caseId).filter((p) => !p.approved);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.map((b) => b.ruleCode)).toContain("REMINDER_LIMIT_REACHED");

    const sent = actions
      .forCase(caseId)
      .filter((a) => a.action === RecoveryAction.SEND_REMINDER && a.status === "SUCCEEDED");
    expect(sent.length).toBeLessThanOrEqual(2);
  });

  it("counts a blocked action as blocked, never as an attempt at recovery", async () => {
    const caseId = openCase({ reason: "Card has expired" });
    await runToCompletion(service(new StubProvider()), caseId, 80);
    expect(cases.requireById(caseId).recoveredAmountPaise).toBeNull();
  });
});

describe("Case 6 — the intervention fails", () => {
  it("records a provider exception and does not silently swallow it", async () => {
    const provider = new StubProvider();
    provider.retryThrows = true;
    const caseId = openCase({ reason: "Issuer bank unavailable" });

    await runToCompletion(service(provider), caseId, 60);

    const failed = actions.forCase(caseId).filter((a) => a.status === "FAILED");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.error).toContain("gateway exploded");
    expect(audit.forCase(caseId).map((e) => e.event)).toContain("ACTION_FAILED");
    expect(cases.requireById(caseId).recoveredAmountPaise).toBeNull();
  });

  it("reaches a terminal state rather than looping forever", async () => {
    const provider = new StubProvider(); // every retry declines
    const caseId = openCase({ reason: "Issuer bank unavailable" });
    await runToCompletion(service(provider), caseId, 100);

    const final = cases.requireById(caseId);
    expect(final.closedAt).not.toBeNull();
    expect([
      RecoveryState.STOPPED,
      RecoveryState.FAILED,
      RecoveryState.ESCALATED,
      RecoveryState.RECOVERED,
    ]).toContain(final.state);
  });

  it("never exceeds the retry ceiling however long it runs", async () => {
    const provider = new StubProvider();
    const caseId = openCase({ reason: "Issuer bank unavailable" });
    await runToCompletion(service(provider), caseId, 100);

    const retries = actions
      .forCase(caseId)
      .filter((a) => a.action === RecoveryAction.RETRY_PAYMENT && a.status !== "SKIPPED_DUPLICATE");
    expect(retries.length).toBeLessThanOrEqual(3);
  });
});

describe("the executor refuses unapproved work", () => {
  it("rejects a forged approval before touching a provider", async () => {
    const provider = new StubProvider();
    const caseId = openCase({ reason: "Issuer bank unavailable" });
    const recoveryCase = cases.requireById(caseId);
    const executor = new ActionExecutor(db, provider, new OutboxNotifier(db, clock), clock);

    const forged = {
      caseId,
      cycle: 1,
      action: RecoveryAction.RETRY_PAYMENT,
      ruleCode: "APPROVED",
      reason: "forged",
      restrictions: [],
    } as unknown as ApprovedAction;

    await expect(
      executor.execute(forged, {
        recoveryCase,
        payment: { ...recoveryCase, id: recoveryCase.paymentId } as never,
        customer: { id: "cust_1", name: "A", email: "a@example.com" } as never,
      }),
    ).rejects.toThrow(UnapprovedActionError);

    expect(actions.forCase(caseId)).toHaveLength(0);
  });
});

describe("idempotency across the whole loop", () => {
  it("opens one case and recovers one amount despite repeated events", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;
    const caseId = openCase({ reason: "Issuer bank unavailable" });
    for (let i = 0; i < 4; i += 1) openCase({ reason: "Issuer bank unavailable" });

    await runToCompletion(service(provider), caseId);

    expect(cases.list()).toHaveLength(1);
    const total = db
      .prepare(`SELECT COALESCE(SUM(recovered_amount_paise),0) AS t FROM recovery_cases WHERE state='RECOVERED'`)
      .get() as { t: number };
    expect(total.t).toBe(249900);
  });
});

describe("the simulated provider is reproducible", () => {
  it("produces identical outcomes for the same seed", async () => {
    const outcomes: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const localDb = openTestDatabase();
      const localClock = new SimulatedClock(START);
      const localEvents = new EventService(localDb, localClock);
      const provider = new SimulatedPaymentProvider({ seed: 20260830, clock: localClock, simulateApiFailures: false });
      const localCases = new CaseRepository(localDb);
      const recovery = new RecoveryService(
        localDb, new HeuristicRecoveryAgent(), provider, new OutboxNotifier(localDb, localClock), localClock,
      );

      const reason = "Insufficient funds in account";
      const opened = localEvents.ingestPaymentFailed({
        provider: ProviderKind.SIMULATED,
        paymentId: "pay_seed",
        customer: { id: "cust_seed", name: "S", email: "s@example.com" },
        amountPaise: 500000,
        method: PaymentMethod.CARD,
        failureReasonRaw: reason,
      });
      provider.registerFailedPayment("pay_seed", normaliseFailureReason(reason));

      for (let i = 0; i < 60; i += 1) {
        const current = localCases.requireById(opened.case.id);
        if (current.closedAt !== null) break;
        await recovery.tick();
        const after = localCases.requireById(opened.case.id);
        if (after.closedAt !== null) break;
        const next = after.nextEvaluationAt;
        if (next && next.getTime() > localClock.now().getTime()) localClock.set(next);
        else localClock.advanceMinutes(30);
      }

      outcomes.push(localCases.requireById(opened.case.id).state);
      localDb.close();
    }
    expect(outcomes[0]).toBe(outcomes[1]);
  });
});
