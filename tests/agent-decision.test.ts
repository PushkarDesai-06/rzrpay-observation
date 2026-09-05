import { describe, it, expect } from "vitest";
import { parseDecision, InvalidDecisionError, DecisionSchema } from "@/core/agent/decision-schema";
import { decideHeuristically } from "@/core/agent/heuristic-decider";
import { AnthropicRecoveryAgent } from "@/core/agent/anthropic-agent";
import { HeuristicRecoveryAgent } from "@/core/agent/recovery-agent";
import { buildRecoveryContext, type RecoveryContext } from "@/core/context/recovery-context";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import {
  DecisionSource,
  Diagnosis,
  FailureCode,
  PaymentMethod,
  PaymentStatus,
  ProviderKind,
  Recoverability,
  RecoveryAction,
  RecoveryState,
} from "@/core/domain/enums";
import type Anthropic from "@anthropic-ai/sdk";

const NOW = new Date("2026-08-30T12:00:00.000Z");

const VALID = {
  diagnosis: "TEMPORARY_FAILURE",
  recoverability: "HIGH",
  confidence: 0.86,
  recommended_action: "RETRY_PAYMENT",
  reasoning_summary: "Issuer was briefly unavailable; the customer has three prior successful payments.",
  expected_value_paise: 162435,
};

describe("agent output validation", () => {
  it("accepts a well-formed decision", () => {
    const decision = parseDecision(VALID);
    expect(decision.diagnosis).toBe(Diagnosis.TEMPORARY_FAILURE);
    expect(decision.recommendedAction).toBe(RecoveryAction.RETRY_PAYMENT);
    expect(decision.confidence).toBeCloseTo(0.86);
  });

  it("rejects an action outside the allowed set", () => {
    expect(() => parseDecision({ ...VALID, recommended_action: "REFUND_CUSTOMER" })).toThrow(
      InvalidDecisionError,
    );
  });

  it("rejects an invented action that sounds plausible", () => {
    for (const action of ["CHARGE_CARD", "CALL_CUSTOMER", "retry_payment", "RETRY", ""]) {
      expect(() => parseDecision({ ...VALID, recommended_action: action })).toThrow(
        InvalidDecisionError,
      );
    }
  });

  it("rejects a missing confidence", () => {
    const { confidence, ...withoutConfidence } = VALID;
    void confidence;
    expect(() => parseDecision(withoutConfidence)).toThrow(InvalidDecisionError);
  });

  it("rejects a confidence outside 0..1", () => {
    expect(() => parseDecision({ ...VALID, confidence: 1.4 })).toThrow(InvalidDecisionError);
    expect(() => parseDecision({ ...VALID, confidence: -0.2 })).toThrow(InvalidDecisionError);
    expect(() => parseDecision({ ...VALID, confidence: "high" })).toThrow(InvalidDecisionError);
  });

  it("rejects an unsupported diagnosis", () => {
    expect(() => parseDecision({ ...VALID, diagnosis: "CUSTOMER_IS_BROKE" })).toThrow(
      InvalidDecisionError,
    );
  });

  it("rejects an unsupported recoverability", () => {
    expect(() => parseDecision({ ...VALID, recoverability: "VERY_HIGH" })).toThrow(
      InvalidDecisionError,
    );
  });

  it("rejects malformed output entirely", () => {
    for (const malformed of [null, undefined, "not json", 42, [], {}]) {
      expect(() => parseDecision(malformed)).toThrow(InvalidDecisionError);
    }
  });

  it("rejects a non-integer or negative expected value", () => {
    expect(() => parseDecision({ ...VALID, expected_value_paise: 1234.5 })).toThrow();
    expect(() => parseDecision({ ...VALID, expected_value_paise: -1 })).toThrow();
  });

  it("names the offending fields so a repair attempt can be specific", () => {
    try {
      parseDecision({ ...VALID, confidence: 5, recommended_action: "NOPE" });
      expect.unreachable("should have thrown");
    } catch (error) {
      const issues = (error as InvalidDecisionError).issues.join(" ");
      expect(issues).toContain("confidence");
      expect(issues).toContain("recommended_action");
    }
  });

  it("exposes only the six allowed actions in its schema", () => {
    const json = DecisionSchema.shape.recommended_action;
    expect(Object.keys(json.enum).sort()).toEqual(
      [...Object.values(RecoveryAction)].sort(),
    );
  });
});

function makeContext(overrides: {
  failureCode?: FailureCode;
  amountPaise?: number;
  successfulPayments?: number;
  retriesAttempted?: number;
  paymentLinksCreated?: number;
  remindersSent?: number;
  hoursOpen?: number;
} = {}): RecoveryContext {
  const openedAt = new Date(NOW.getTime() - (overrides.hoursOpen ?? 1) * 3_600_000);
  return buildRecoveryContext({
    recoveryCase: {
      id: "case_1",
      paymentId: "pay_1",
      customerId: "cust_1",
      amountPaise: overrides.amountPaise ?? 249900,
      currency: "INR",
      state: RecoveryState.ANALYZING,
      diagnosis: null,
      recoverability: null,
      confidence: null,
      cycleCount: 1,
      openedAt,
      updatedAt: openedAt,
      nextEvaluationAt: null,
      closedAt: null,
      recoveredAt: null,
      recoveredAmountPaise: null,
    },
    payment: {
      id: "pay_1",
      customerId: "cust_1",
      amountPaise: overrides.amountPaise ?? 249900,
      currency: "INR",
      status: PaymentStatus.FAILED,
      method: PaymentMethod.CARD,
      failureCode: overrides.failureCode ?? FailureCode.ISSUER_UNAVAILABLE,
      failureReasonRaw: "issuer down",
      attemptNumber: 1,
      provider: ProviderKind.SIMULATED,
      createdAt: openedAt,
      updatedAt: openedAt,
    },
    customer: {
      id: "cust_1",
      name: "Asha Menon",
      email: "asha@example.com",
      createdAt: new Date("2025-08-30T10:00:00.000Z"),
      lifetimeValuePaise: 1_000_000,
      successfulPaymentsCount: overrides.successfulPayments ?? 4,
      failedPaymentsCount: 1,
      lastSuccessfulPaymentAt: new Date("2026-07-30T10:00:00.000Z"),
    },
    cycle: 1,
    retriesAttempted: overrides.retriesAttempted ?? 0,
    remindersSent: overrides.remindersSent ?? 0,
    paymentLinksCreated: overrides.paymentLinksCreated ?? 0,
    lastCustomerContactAt: null,
    lastRetryAt: null,
    priorActions: [],
    policy: DEFAULT_POLICY,
    now: NOW,
  });
}

describe("the deterministic decider", () => {
  it("retries a transient issuer failure", () => {
    const decision = decideHeuristically(makeContext({ failureCode: FailureCode.ISSUER_UNAVAILABLE }));
    expect(decision.diagnosis).toBe(Diagnosis.TEMPORARY_FAILURE);
    expect(decision.recommendedAction).toBe(RecoveryAction.RETRY_PAYMENT);
    expect(decision.confidence).toBeGreaterThan(0.8);
  });

  it("never retries an expired card", () => {
    const decision = decideHeuristically(makeContext({ failureCode: FailureCode.CARD_EXPIRED }));
    expect(decision.recommendedAction).not.toBe(RecoveryAction.RETRY_PAYMENT);
    expect(decision.recommendedAction).toBe(RecoveryAction.CREATE_PAYMENT_LINK);
  });

  it("reports low confidence on an unexplained failure rather than guessing", () => {
    const decision = decideHeuristically(makeContext({ failureCode: FailureCode.UNKNOWN }));
    expect(decision.diagnosis).toBe(Diagnosis.UNKNOWN);
    expect(decision.confidence).toBeLessThan(DEFAULT_POLICY.minimumConfidence);
  });

  it("escalates a high-value case rather than acting", () => {
    const decision = decideHeuristically(makeContext({ amountPaise: 5_000_000 }));
    expect(decision.recommendedAction).toBe(RecoveryAction.ESCALATE);
  });

  it("stops once the recovery window has closed", () => {
    const decision = decideHeuristically(makeContext({ hoursOpen: 80 }));
    expect(decision.recommendedAction).toBe(RecoveryAction.STOP);
  });

  it("moves to a reminder after a link exists and retries are spent", () => {
    const decision = decideHeuristically(
      makeContext({ failureCode: FailureCode.CARD_EXPIRED, paymentLinksCreated: 1 }),
    );
    expect(decision.recommendedAction).toBe(RecoveryAction.SEND_REMINDER);
  });

  it("stops when every avenue is exhausted", () => {
    const decision = decideHeuristically(
      makeContext({
        failureCode: FailureCode.CARD_EXPIRED,
        paymentLinksCreated: 1,
        remindersSent: 2,
      }),
    );
    expect(decision.recommendedAction).toBe(RecoveryAction.STOP);
  });

  it("rates a proven payer above a customer who has never paid", () => {
    const proven = decideHeuristically(makeContext({ successfulPayments: 8 }));
    const unproven = decideHeuristically(makeContext({ successfulPayments: 0 }));
    expect(proven.expectedValuePaise).toBeGreaterThan(unproven.expectedValuePaise);
  });

  it("produces output that always passes schema validation", () => {
    for (const code of Object.values(FailureCode)) {
      const decision = decideHeuristically(makeContext({ failureCode: code }));
      expect(() =>
        parseDecision({
          diagnosis: decision.diagnosis,
          recoverability: decision.recoverability,
          confidence: decision.confidence,
          recommended_action: decision.recommendedAction,
          reasoning_summary: decision.reasoningSummary,
          expected_value_paise: decision.expectedValuePaise,
        }),
      ).not.toThrow();
    }
  });

  it("is deterministic", () => {
    const context = makeContext();
    expect(decideHeuristically(context)).toEqual(decideHeuristically(context));
  });
});

/** Minimal stand-in for the SDK client, so no test ever touches the network. */
function fakeClient(parse: (...args: unknown[]) => Promise<unknown>): Anthropic {
  return { messages: { parse } } as unknown as Anthropic;
}

describe("agent failure handling", () => {
  it("returns a model decision when the call succeeds", async () => {
    const agent = new AnthropicRecoveryAgent(
      fakeClient(() => Promise.resolve({ parsed_output: VALID, stop_reason: "end_turn" })),
    );
    const result = await agent.decide(makeContext());
    expect(result.source).toBe(DecisionSource.LLM);
    expect(result.decision.recommendedAction).toBe(RecoveryAction.RETRY_PAYMENT);
    expect(result.warnings).toEqual([]);
  });

  it("repairs one malformed response and keeps the model decision", async () => {
    let call = 0;
    const agent = new AnthropicRecoveryAgent(
      fakeClient(() => {
        call += 1;
        return Promise.resolve(
          call === 1
            ? { parsed_output: { ...VALID, recommended_action: "NONSENSE" }, stop_reason: "end_turn" }
            : { parsed_output: VALID, stop_reason: "end_turn" },
        );
      }),
    );
    const result = await agent.decide(makeContext());
    expect(call).toBe(2);
    expect(result.source).toBe(DecisionSource.LLM);
    expect(result.warnings.join(" ")).toContain("recommended_action");
  });

  it("falls back deterministically when both attempts fail, and says so", async () => {
    const agent = new AnthropicRecoveryAgent(
      fakeClient(() => Promise.resolve({ parsed_output: { garbage: true }, stop_reason: "end_turn" })),
    );
    const result = await agent.decide(makeContext());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    expect(result.model).toBeNull();
    expect(result.warnings.join(" ")).toContain("not a model decision");
    // Still a usable, valid decision — the loop is not left stranded.
    expect(Object.values(RecoveryAction)).toContain(result.decision.recommendedAction);
  });

  it("falls back when the provider is unreachable", async () => {
    const agent = new AnthropicRecoveryAgent(
      fakeClient(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const result = await agent.decide(makeContext());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    expect(result.warnings.join(" ")).toContain("ECONNREFUSED");
  });

  it("falls back without a second call when the model declines", async () => {
    let calls = 0;
    const agent = new AnthropicRecoveryAgent(
      fakeClient(() => {
        calls += 1;
        return Promise.resolve({
          parsed_output: null,
          stop_reason: "refusal",
          stop_details: { category: "cyber" },
        });
      }),
    );
    const result = await agent.decide(makeContext());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    expect(calls).toBe(2); // a refusal is worth one retry; the fallback still catches it
  });

  it("labels a heuristic-only agent honestly", async () => {
    const result = await new HeuristicRecoveryAgent().decide(makeContext());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    expect(result.model).toBeNull();
  });
});
