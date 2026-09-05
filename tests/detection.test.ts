import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openTestDatabase, type Database } from "@/db/client";
import { SimulatedClock } from "@/core/clock";
import { EventService, type PaymentFailedEvent } from "@/services/event-service";
import { CaseRepository } from "@/db/repositories/case-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";
import { normaliseFailureReason } from "@/core/domain/failure-codes";
import { FailureCode, PaymentMethod, ProviderKind, RecoveryState } from "@/core/domain/enums";
import { InvalidTransitionError } from "@/core/state/state-machine";

let db: Database;
let clock: SimulatedClock;
let events: EventService;
let cases: CaseRepository;
let audit: AuditRepository;

const failure = (overrides: Partial<PaymentFailedEvent> = {}): PaymentFailedEvent => ({
  provider: ProviderKind.SIMULATED,
  paymentId: "pay_abc",
  customer: { id: "cust_1", name: "Asha Menon", email: "asha@example.com" },
  amountPaise: 249900,
  method: PaymentMethod.CARD,
  failureReasonRaw: "Issuer bank unavailable, please retry",
  ...overrides,
});

beforeEach(() => {
  db = openTestDatabase();
  clock = new SimulatedClock(new Date("2026-08-30T10:00:00.000Z"));
  events = new EventService(db, clock);
  cases = new CaseRepository(db);
  audit = new AuditRepository(db);
});
afterEach(() => db.close());

describe("failure reason normalisation", () => {
  it("maps provider prose onto the closed code set", () => {
    expect(normaliseFailureReason("Insufficient funds in account")).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(normaliseFailureReason("Card has expired")).toBe(FailureCode.CARD_EXPIRED);
    expect(normaliseFailureReason("Incorrect CVV supplied")).toBe(FailureCode.INCORRECT_CVV);
    expect(normaliseFailureReason("Issuer bank down")).toBe(FailureCode.ISSUER_UNAVAILABLE);
    expect(normaliseFailureReason("Gateway timed out")).toBe(FailureCode.GATEWAY_TIMEOUT);
    expect(normaliseFailureReason("3DS authentication failed")).toBe(FailureCode.AUTHENTICATION_FAILED);
    expect(normaliseFailureReason("Payment cancelled by user")).toBe(FailureCode.PAYMENT_CANCELLED);
  });

  it("accepts an exact provider code", () => {
    expect(normaliseFailureReason("INSUFFICIENT_FUNDS")).toBe(FailureCode.INSUFFICIENT_FUNDS);
  });

  it("falls back to UNKNOWN rather than guessing", () => {
    expect(normaliseFailureReason("ERR_7731")).toBe(FailureCode.UNKNOWN);
    expect(normaliseFailureReason(null)).toBe(FailureCode.UNKNOWN);
    expect(normaliseFailureReason("")).toBe(FailureCode.UNKNOWN);
  });
});

describe("detection opens exactly one case per payment", () => {
  it("opens a case in DETECTED on first failure", () => {
    const result = events.ingestPaymentFailed(failure());
    expect(result.accepted).toBe(true);
    expect(result.caseCreated).toBe(true);
    expect(result.case.state).toBe(RecoveryState.DETECTED);
    expect(result.case.amountPaise).toBe(249900);
    expect(result.case.paymentId).toBe("pay_abc");
  });

  it("ignores a redelivered event without opening a second case", () => {
    const first = events.ingestPaymentFailed(failure());
    const second = events.ingestPaymentFailed(failure());

    expect(second.accepted).toBe(false);
    expect(second.caseCreated).toBe(false);
    expect(second.case.id).toBe(first.case.id);

    const count = db.prepare("SELECT COUNT(*) AS n FROM recovery_cases").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("survives five redeliveries and still reports the revenue once", () => {
    for (let i = 0; i < 5; i += 1) {
      clock.advanceMinutes(1);
      events.ingestPaymentFailed(failure());
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM recovery_cases").get() as { n: number };
    expect(count.n).toBe(1);
    expect(events.revenueAtRiskPaise()).toBe(249900);
  });

  it("records the duplicate in the audit trail rather than dropping it silently", () => {
    const first = events.ingestPaymentFailed(failure());
    events.ingestPaymentFailed(failure());
    const entries = audit.forCase(first.case.id).map((e) => e.event);
    expect(entries).toContain("CASE_CREATED");
    expect(entries).toContain("DUPLICATE_EVENT_IGNORED");
  });

  it("opens separate cases for genuinely different payments", () => {
    events.ingestPaymentFailed(failure({ paymentId: "pay_1" }));
    events.ingestPaymentFailed(failure({ paymentId: "pay_2", amountPaise: 100000 }));
    const count = db.prepare("SELECT COUNT(*) AS n FROM recovery_cases").get() as { n: number };
    expect(count.n).toBe(2);
    expect(events.revenueAtRiskPaise()).toBe(349900);
  });

  it("stores the normalised failure code on the payment", () => {
    events.ingestPaymentFailed(failure({ failureReasonRaw: "Insufficient funds" }));
    const row = db.prepare("SELECT failure_code FROM payments WHERE id = ?").get("pay_abc") as {
      failure_code: string;
    };
    expect(row.failure_code).toBe(FailureCode.INSUFFICIENT_FUNDS);
  });
});

describe("state transitions through the repository", () => {
  let caseId: string;

  beforeEach(() => {
    caseId = events.ingestPaymentFailed(failure()).case.id;
  });

  it("permits a legal move and records it on the timeline", () => {
    clock.advanceMinutes(1);
    const updated = cases.transitionState({
      caseId,
      to: RecoveryState.ANALYZING,
      trigger: "evaluation_started",
      at: clock.now(),
    });
    expect(updated.state).toBe(RecoveryState.ANALYZING);

    const timeline = cases.timeline(caseId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.fromState).toBe(RecoveryState.DETECTED);
    expect(timeline[0]!.toState).toBe(RecoveryState.ANALYZING);
    expect(timeline[0]!.trigger).toBe("evaluation_started");
  });

  it("rejects an illegal move and writes nothing", () => {
    expect(() =>
      cases.transitionState({
        caseId,
        to: RecoveryState.RECOVERED,
        trigger: "wishful_thinking",
        at: clock.now(),
        recoveredAmountPaise: 249900,
      }),
    ).toThrow(InvalidTransitionError);

    expect(cases.requireById(caseId).state).toBe(RecoveryState.DETECTED);
    expect(cases.timeline(caseId)).toHaveLength(0);
    expect(cases.requireById(caseId).recoveredAmountPaise).toBeNull();
  });

  it("refuses to mark a case RECOVERED without a confirmed amount", () => {
    const path = [
      RecoveryState.ANALYZING,
      RecoveryState.RECOVERY_CANDIDATE,
      RecoveryState.ACTION_PLANNED,
      RecoveryState.POLICY_VALIDATED,
      RecoveryState.ACTION_EXECUTING,
      RecoveryState.WAITING_FOR_OUTCOME,
    ];
    for (const to of path) {
      cases.transitionState({ caseId, to, trigger: "advance", at: clock.now() });
    }

    expect(() =>
      cases.transitionState({
        caseId,
        to: RecoveryState.RECOVERED,
        trigger: "outcome_observed",
        at: clock.now(),
      }),
    ).toThrow(/without a confirmed recovered amount/);

    expect(cases.requireById(caseId).state).toBe(RecoveryState.WAITING_FOR_OUTCOME);
  });

  it("refuses to attach recovered revenue to a non-recovered outcome", () => {
    cases.transitionState({ caseId, to: RecoveryState.ANALYZING, trigger: "advance", at: clock.now() });
    expect(() =>
      cases.transitionState({
        caseId,
        to: RecoveryState.ESCALATED,
        trigger: "low_confidence",
        at: clock.now(),
        recoveredAmountPaise: 249900,
      }),
    ).toThrow(/Refusing to record recovered revenue/);
  });

  it("closes the case and clears its schedule on a terminal transition", () => {
    cases.transitionState({ caseId, to: RecoveryState.ANALYZING, trigger: "advance", at: clock.now() });
    clock.advanceHours(1);
    const stopped = cases.transitionState({
      caseId,
      to: RecoveryState.ESCALATED,
      trigger: "low_confidence",
      at: clock.now(),
    });
    expect(stopped.closedAt).not.toBeNull();
    expect(stopped.nextEvaluationAt).toBeNull();
    expect(stopped.recoveredAmountPaise).toBeNull();
  });

  it("removes the amount from revenue at risk once the case closes", () => {
    expect(events.revenueAtRiskPaise()).toBe(249900);
    cases.transitionState({ caseId, to: RecoveryState.ANALYZING, trigger: "advance", at: clock.now() });
    cases.transitionState({ caseId, to: RecoveryState.NOT_RECOVERABLE, trigger: "unrecoverable", at: clock.now() });
    expect(events.revenueAtRiskPaise()).toBe(0);
  });

  it("records every transition in the audit trail", () => {
    cases.transitionState({ caseId, to: RecoveryState.ANALYZING, trigger: "advance", at: clock.now() });
    cases.transitionState({ caseId, to: RecoveryState.RECOVERY_CANDIDATE, trigger: "advance", at: clock.now() });
    const transitions = audit.forCase(caseId).filter((e) => e.event === "STATE_TRANSITION");
    expect(transitions).toHaveLength(2);
    expect(transitions[0]!.detail).toMatchObject({ from: "DETECTED", to: "ANALYZING" });
  });
});

describe("scheduling", () => {
  it("queues a newly opened case for immediate evaluation", () => {
    const { case: opened } = events.ingestPaymentFailed(failure());
    const due = cases.dueForEvaluation(clock.now());
    expect(due.map((c) => c.id)).toContain(opened.id);
  });

  it("does not return a case scheduled for the future", () => {
    const { case: opened } = events.ingestPaymentFailed(failure());
    cases.scheduleNextEvaluation(opened.id, new Date(clock.now().getTime() + 3_600_000));
    expect(cases.dueForEvaluation(clock.now())).toHaveLength(0);
  });
});
