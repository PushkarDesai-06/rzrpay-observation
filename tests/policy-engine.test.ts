import { describe, it, expect } from "vitest";
import {
  evaluate,
  PolicyOutcome,
  ApprovedAction,
  type PolicyFacts,
  type PolicyInput,
} from "@/core/policy/policy-engine";
import { DEFAULT_POLICY, PolicyRuleCode } from "@/core/policy/policy-config";
import {
  Diagnosis,
  FailureCode,
  Recoverability,
  RecoveryAction,
  RecoveryState,
} from "@/core/domain/enums";
import type { RecoveryCase, RecoveryDecision } from "@/core/domain/types";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const OPENED = new Date("2026-08-30T10:00:00.000Z");

function makeCase(overrides: Partial<RecoveryCase> = {}): RecoveryCase {
  return {
    id: "case_1",
    paymentId: "pay_1",
    customerId: "cust_1",
    amountPaise: 249900,
    currency: "INR",
    state: RecoveryState.ACTION_PLANNED,
    diagnosis: null,
    recoverability: null,
    confidence: null,
    cycleCount: 1,
    openedAt: OPENED,
    updatedAt: OPENED,
    nextEvaluationAt: null,
    closedAt: null,
    recoveredAt: null,
    recoveredAmountPaise: null,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<RecoveryDecision> = {}): RecoveryDecision {
  return {
    diagnosis: Diagnosis.TEMPORARY_FAILURE,
    recoverability: Recoverability.HIGH,
    confidence: 0.86,
    recommendedAction: RecoveryAction.RETRY_PAYMENT,
    reasoningSummary: "Issuer was unavailable and the customer has paid before.",
    expectedValuePaise: 162435,
    ...overrides,
  };
}

function makeFacts(overrides: Partial<PolicyFacts> = {}): PolicyFacts {
  return {
    retriesAttempted: 0,
    remindersSent: 0,
    paymentLinksCreated: 0,
    customerMessagesSent: 0,
    hasOpenPaymentLink: false,
    lastRetryAt: null,
    lastCustomerContactAt: null,
    actionsInTrailingDay: 0,
    failureCode: FailureCode.ISSUER_UNAVAILABLE,
    ...overrides,
  };
}

function run(overrides: {
  recoveryCase?: Partial<RecoveryCase>;
  decision?: Partial<RecoveryDecision>;
  facts?: Partial<PolicyFacts>;
  now?: Date;
} = {}) {
  const input: PolicyInput = {
    recoveryCase: makeCase(overrides.recoveryCase),
    decision: makeDecision(overrides.decision),
    facts: makeFacts(overrides.facts),
    policy: DEFAULT_POLICY,
    now: overrides.now ?? NOW,
  };
  return evaluate(input);
}

describe("the happy path", () => {
  it("approves a well-supported retry", () => {
    const result = run();
    expect(result.outcome).toBe(PolicyOutcome.APPROVED);
    expect(result.effectiveAction).toBe(RecoveryAction.RETRY_PAYMENT);
    expect(result.ruleCode).toBe(PolicyRuleCode.APPROVED);
    expect(result.overridden).toBe(false);
    expect(result.approvedAction).toBeInstanceOf(ApprovedAction);
  });

  it("mints a permission slip naming the case, cycle and action", () => {
    const result = run();
    expect(result.approvedAction?.caseId).toBe("case_1");
    expect(result.approvedAction?.cycle).toBe(1);
    expect(result.approvedAction?.action).toBe(RecoveryAction.RETRY_PAYMENT);
  });

  it("freezes the permission slip against tampering", () => {
    const approved = run().approvedAction!;
    expect(Object.isFrozen(approved)).toBe(true);
    expect(() => {
      (approved as unknown as { action: string }).action = RecoveryAction.CREATE_PAYMENT_LINK;
    }).toThrow();
    expect(approved.action).toBe(RecoveryAction.RETRY_PAYMENT);
  });
});

describe("the agent cannot bypass the policy layer", () => {
  it("mints nothing whenever an action is blocked", () => {
    const result = run({ facts: { retriesAttempted: 3 } });
    expect(result.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(result.approvedAction).toBeNull();
  });

  it("mints nothing when it diverts to escalation or stop", () => {
    const escalated = run({ decision: { confidence: 0.2 } });
    expect(escalated.outcome).toBe(PolicyOutcome.ESCALATE);
    expect(escalated.approvedAction).toBeNull();

    const stopped = run({ decision: { recoverability: Recoverability.NOT_RECOVERABLE } });
    expect(stopped.outcome).toBe(PolicyOutcome.STOP);
    expect(stopped.approvedAction).toBeNull();
  });

  it("offers no public way to construct a permission slip", () => {
    // The constructor is private; `mint` is reachable only from evaluate().
    // Confirm that a hand-built lookalike is not an ApprovedAction, so the
    // executor's instanceof check cannot be satisfied by a forged object.
    const forged = {
      caseId: "case_1",
      cycle: 1,
      action: RecoveryAction.RETRY_PAYMENT,
      ruleCode: PolicyRuleCode.APPROVED,
      reason: "forged",
      restrictions: [],
    };
    expect(forged).not.toBeInstanceOf(ApprovedAction);
  });

  it("ignores what the agent believed its budget to be", () => {
    // The decision asks to retry; the ledger says the budget is spent.
    // Enforcement reads the ledger.
    const result = run({
      decision: { recommendedAction: RecoveryAction.RETRY_PAYMENT, confidence: 0.99 },
      facts: { retriesAttempted: 3 },
    });
    expect(result.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(result.ruleCode).toBe(PolicyRuleCode.RETRY_LIMIT_REACHED);
  });
});

describe("hard stops", () => {
  it("stops a case that is already terminal", () => {
    const result = run({ recoveryCase: { state: RecoveryState.RECOVERED } });
    expect(result.outcome).toBe(PolicyOutcome.STOP);
    expect(result.ruleCode).toBe(PolicyRuleCode.CASE_TERMINAL);
  });

  it("stops once the recovery window has expired", () => {
    const result = run({ now: new Date("2026-09-02T11:00:00.000Z") }); // 73h later
    expect(result.outcome).toBe(PolicyOutcome.STOP);
    expect(result.ruleCode).toBe(PolicyRuleCode.RECOVERY_WINDOW_EXPIRED);
  });

  it("allows action just inside the window", () => {
    const result = run({ now: new Date("2026-09-02T09:00:00.000Z") }); // 71h later
    expect(result.outcome).toBe(PolicyOutcome.APPROVED);
  });

  it("blocks everything once the system-wide daily cap is reached", () => {
    const result = run({ facts: { actionsInTrailingDay: 500 } });
    expect(result.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(result.ruleCode).toBe(PolicyRuleCode.GLOBAL_ACTION_CAP);
  });

  it("stops when the agent judged the revenue unrecoverable", () => {
    const result = run({ decision: { recoverability: Recoverability.NOT_RECOVERABLE } });
    expect(result.outcome).toBe(PolicyOutcome.STOP);
    expect(result.ruleCode).toBe(PolicyRuleCode.NOT_RECOVERABLE);
  });

  it("stops chasing an amount too small to be worth it", () => {
    const result = run({ recoveryCase: { amountPaise: 4_999 } });
    expect(result.outcome).toBe(PolicyOutcome.STOP);
    expect(result.ruleCode).toBe(PolicyRuleCode.AMOUNT_BELOW_RECOVERY_THRESHOLD);
  });
});

describe("escalation overrides", () => {
  it("escalates a high-value case regardless of what was proposed", () => {
    const result = run({
      recoveryCase: { amountPaise: 2_500_000 },
      decision: { recommendedAction: RecoveryAction.RETRY_PAYMENT, confidence: 0.97 },
    });
    expect(result.outcome).toBe(PolicyOutcome.ESCALATE);
    expect(result.ruleCode).toBe(PolicyRuleCode.HIGH_VALUE_ESCALATION);
    expect(result.originalAction).toBe(RecoveryAction.RETRY_PAYMENT);
    expect(result.overridden).toBe(true);
  });

  it("leaves a high-value case alone if the agent already chose to escalate", () => {
    const result = run({
      recoveryCase: { amountPaise: 2_500_000 },
      decision: { recommendedAction: RecoveryAction.ESCALATE },
    });
    expect(result.outcome).toBe(PolicyOutcome.ESCALATE);
    expect(result.overridden).toBe(false);
  });

  it("escalates rather than acting on low confidence", () => {
    const result = run({ decision: { confidence: 0.59 } });
    expect(result.outcome).toBe(PolicyOutcome.ESCALATE);
    expect(result.ruleCode).toBe(PolicyRuleCode.LOW_CONFIDENCE_ESCALATION);
  });

  it("acts at exactly the confidence floor", () => {
    const result = run({ decision: { confidence: 0.6 } });
    expect(result.outcome).not.toBe(PolicyOutcome.ESCALATE);
  });

  it("never answers low confidence with a more aggressive action", () => {
    const result = run({
      decision: { confidence: 0.3, recommendedAction: RecoveryAction.RETRY_PAYMENT },
    });
    expect(result.effectiveAction).toBe(RecoveryAction.ESCALATE);
    expect(result.effectiveAction).not.toBe(RecoveryAction.RETRY_PAYMENT);
  });
});

describe("money-moving actions face a higher bar", () => {
  it("downgrades a shaky retry to a payment link", () => {
    const result = run({ decision: { confidence: 0.7 } });
    expect(result.outcome).toBe(PolicyOutcome.APPROVED);
    expect(result.originalAction).toBe(RecoveryAction.RETRY_PAYMENT);
    expect(result.effectiveAction).toBe(RecoveryAction.CREATE_PAYMENT_LINK);
    expect(result.overridden).toBe(true);
    expect(result.ruleCode).toBe(PolicyRuleCode.FINANCIAL_ACTION_CONFIDENCE);
    expect(result.approvedAction?.action).toBe(RecoveryAction.CREATE_PAYMENT_LINK);
  });

  it("escalates instead when no payment link is available to downgrade to", () => {
    const result = run({
      decision: { confidence: 0.7 },
      facts: { hasOpenPaymentLink: true },
    });
    expect(result.outcome).toBe(PolicyOutcome.ESCALATE);
    expect(result.ruleCode).toBe(PolicyRuleCode.FINANCIAL_ACTION_CONFIDENCE);
  });

  it("leaves a confident retry alone", () => {
    const result = run({ decision: { confidence: 0.75 } });
    expect(result.effectiveAction).toBe(RecoveryAction.RETRY_PAYMENT);
  });

  it("does not apply the financial bar to sending a reminder", () => {
    const result = run({
      decision: { confidence: 0.65, recommendedAction: RecoveryAction.SEND_REMINDER },
      facts: { paymentLinksCreated: 1 },
    });
    expect(result.outcome).toBe(PolicyOutcome.APPROVED);
    expect(result.effectiveAction).toBe(RecoveryAction.SEND_REMINDER);
  });
});

describe("retry limits", () => {
  it("permits the third retry and blocks the fourth", () => {
    expect(run({ facts: { retriesAttempted: 2 } }).outcome).toBe(PolicyOutcome.APPROVED);
    const blocked = run({ facts: { retriesAttempted: 3 } });
    expect(blocked.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(blocked.ruleCode).toBe(PolicyRuleCode.RETRY_LIMIT_REACHED);
  });

  it("never allows unlimited retries", () => {
    for (const attempts of [3, 4, 10, 100]) {
      expect(run({ facts: { retriesAttempted: attempts } }).outcome).toBe(PolicyOutcome.BLOCKED);
    }
  });

  it("blocks a retry that cannot possibly succeed", () => {
    for (const code of [
      FailureCode.CARD_EXPIRED,
      FailureCode.INCORRECT_CVV,
      FailureCode.PAYMENT_CANCELLED,
      FailureCode.AUTHENTICATION_FAILED,
    ]) {
      const result = run({ facts: { failureCode: code } });
      expect(result.outcome, `${code} should block retry`).toBe(PolicyOutcome.BLOCKED);
      expect(result.ruleCode).toBe(PolicyRuleCode.RETRY_FUTILE_HARD_DECLINE);
    }
  });

  it("enforces the interval between retries", () => {
    const tooSoon = run({
      facts: { lastRetryAt: new Date("2026-08-30T11:45:00.000Z"), retriesAttempted: 1 },
    });
    expect(tooSoon.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(tooSoon.ruleCode).toBe(PolicyRuleCode.RETRY_INTERVAL_NOT_ELAPSED);

    const elapsed = run({
      facts: { lastRetryAt: new Date("2026-08-30T11:25:00.000Z"), retriesAttempted: 1 },
    });
    expect(elapsed.outcome).toBe(PolicyOutcome.APPROVED);
  });
});

describe("customer contact limits", () => {
  const reminder = { recommendedAction: RecoveryAction.SEND_REMINDER, confidence: 0.8 };

  it("permits the second reminder and blocks the third", () => {
    expect(
      run({ decision: reminder, facts: { remindersSent: 1, paymentLinksCreated: 1 } }).outcome,
    ).toBe(PolicyOutcome.APPROVED);

    const blocked = run({ decision: reminder, facts: { remindersSent: 2, paymentLinksCreated: 1 } });
    expect(blocked.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(blocked.ruleCode).toBe(PolicyRuleCode.REMINDER_LIMIT_REACHED);
  });

  it("enforces the total message ceiling across message types", () => {
    const result = run({ decision: reminder, facts: { customerMessagesSent: 3 } });
    expect(result.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(result.ruleCode).toBe(PolicyRuleCode.CUSTOMER_MESSAGE_LIMIT_REACHED);
  });

  it("refuses to message a customer twice within the quiet period", () => {
    const tooSoon = run({
      decision: reminder,
      facts: {
        remindersSent: 1,
        paymentLinksCreated: 1,
        lastCustomerContactAt: new Date("2026-08-29T18:00:00.000Z"), // 18h
      },
    });
    expect(tooSoon.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(tooSoon.ruleCode).toBe(PolicyRuleCode.MESSAGE_INTERVAL_NOT_ELAPSED);

    const elapsed = run({
      decision: reminder,
      facts: {
        remindersSent: 1,
        paymentLinksCreated: 1,
        lastCustomerContactAt: new Date("2026-08-29T11:00:00.000Z"), // 25h
      },
    });
    expect(elapsed.outcome).toBe(PolicyOutcome.APPROVED);
  });
});

describe("payment link idempotency", () => {
  const link = { recommendedAction: RecoveryAction.CREATE_PAYMENT_LINK, confidence: 0.8 };

  it("refuses to create a second live link", () => {
    const result = run({ decision: link, facts: { hasOpenPaymentLink: true } });
    expect(result.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(result.ruleCode).toBe(PolicyRuleCode.DUPLICATE_PAYMENT_LINK);
  });

  it("enforces the per-case link budget", () => {
    const result = run({ decision: link, facts: { paymentLinksCreated: 1 } });
    expect(result.outcome).toBe(PolicyOutcome.BLOCKED);
    expect(result.ruleCode).toBe(PolicyRuleCode.PAYMENT_LINK_LIMIT_REACHED);
  });

  it("allows the first link", () => {
    expect(run({ decision: link }).outcome).toBe(PolicyOutcome.APPROVED);
  });
});

describe("non-executable actions", () => {
  it("resolves ESCALATE without minting an execution permit", () => {
    const result = run({ decision: { recommendedAction: RecoveryAction.ESCALATE } });
    expect(result.outcome).toBe(PolicyOutcome.ESCALATE);
    expect(result.approvedAction).toBeNull();
  });

  it("resolves STOP without minting an execution permit", () => {
    const result = run({ decision: { recommendedAction: RecoveryAction.STOP } });
    expect(result.outcome).toBe(PolicyOutcome.STOP);
    expect(result.approvedAction).toBeNull();
  });

  it("approves WAIT as a real, executable choice", () => {
    const result = run({ decision: { recommendedAction: RecoveryAction.WAIT } });
    expect(result.outcome).toBe(PolicyOutcome.APPROVED);
    expect(result.approvedAction?.action).toBe(RecoveryAction.WAIT);
  });
});

describe("determinism", () => {
  it("returns the same verdict for the same inputs", () => {
    const once = run({ decision: { confidence: 0.7 } });
    const twice = run({ decision: { confidence: 0.7 } });
    expect({ ...once, approvedAction: null }).toEqual({ ...twice, approvedAction: null });
  });

  it("always records a rule code and a reason", () => {
    const scenarios = [
      run(),
      run({ facts: { retriesAttempted: 3 } }),
      run({ decision: { confidence: 0.2 } }),
      run({ recoveryCase: { amountPaise: 5_000_000 } }),
      run({ recoveryCase: { state: RecoveryState.STOPPED } }),
    ];
    for (const result of scenarios) {
      expect(result.ruleCode).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
