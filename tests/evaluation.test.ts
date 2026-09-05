import { describe, it, expect } from "vitest";
import { buildRecoveryContext, type RecoveryContext } from "@/core/context/recovery-context";
import {
  DecisionSource,
  FailureCode,
  PaymentMethod,
  PaymentStatus,
  ProviderKind,
  RecoveryAction,
  RecoveryState,
  isTerminal,
} from "@/core/domain/enums";
import { normaliseFailureReason } from "@/core/domain/failure-codes";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import { HeuristicRecoveryAgent } from "@/core/agent/recovery-agent";
import {
  Archetype,
  generateDataset,
  describeMix,
  totalAtRiskPaise,
} from "@/evaluation/dataset";
import {
  AlwaysPaymentLinkBaseline,
  AlwaysRetryOnceBaseline,
  NoInterventionBaseline,
} from "@/evaluation/baselines";
import { runArm } from "@/evaluation/harness";
import { Scenario, scenariosFor, summariseArm, compare } from "@/evaluation/report";
import type { CaseOutcome } from "@/evaluation/harness";

const START = new Date("2026-08-30T09:00:00.000Z");
const SEED = 20260830;

describe("the synthetic dataset", () => {
  it("replays identically for the same seed", () => {
    const a = generateDataset({ size: 40, seed: SEED, detectedAt: START });
    const b = generateDataset({ size: 40, seed: SEED, detectedAt: START });
    expect(b).toEqual(a);
  });

  it("produces a different book for a different seed", () => {
    const a = generateDataset({ size: 40, seed: SEED, detectedAt: START });
    const b = generateDataset({ size: 40, seed: SEED + 1, detectedAt: START });
    expect(b).not.toEqual(a);
  });

  it("generates exactly the requested number of cases at any size", () => {
    for (const size of [1, 3, 7, 12, 50, 101]) {
      expect(generateDataset({ size, seed: SEED, detectedAt: START })).toHaveLength(size);
    }
  });

  it("rejects a size that is not a positive integer", () => {
    expect(() => generateDataset({ size: 0, seed: SEED, detectedAt: START })).toThrow(RangeError);
    expect(() => generateDataset({ size: -5, seed: SEED, detectedAt: START })).toThrow(RangeError);
    expect(() => generateDataset({ size: 2.5, seed: SEED, detectedAt: START })).toThrow(RangeError);
  });

  /**
   * The archetype a case claims to be is only meaningful if the detection layer
   * agrees. This is the invariant that catches the failure-code patterns and
   * the dataset's prose drifting apart.
   */
  it("uses failure prose that the detection layer maps to the declared code", () => {
    const dataset = generateDataset({ size: 600, seed: SEED, detectedAt: START });
    for (const item of dataset) {
      expect(normaliseFailureReason(item.failureReasonRaw)).toBe(item.failureCode);
    }
  });

  it("covers every archetype in a full-size book", () => {
    const dataset = generateDataset({ size: 50, seed: SEED, detectedAt: START });
    const present = new Set(dataset.map((c) => c.archetype));
    for (const archetype of Object.values(Archetype)) {
      expect(present).toContain(archetype);
    }
  });

  it("places high-value cases above the escalation threshold and micro cases below the floor", () => {
    const dataset = generateDataset({ size: 200, seed: SEED, detectedAt: START });

    for (const item of dataset.filter((c) => c.archetype === Archetype.HIGH_VALUE)) {
      expect(item.amountPaise).toBeGreaterThanOrEqual(DEFAULT_POLICY.escalationAmountThresholdPaise);
    }
    for (const item of dataset.filter((c) => c.archetype === Archetype.MICRO_AMOUNT)) {
      expect(item.amountPaise).toBeLessThan(DEFAULT_POLICY.minimumRecoverableAmountPaise);
    }
  });

  it("never dates a customer or their last payment after the failure", () => {
    const dataset = generateDataset({ size: 200, seed: SEED, detectedAt: START });
    for (const item of dataset) {
      const { customer } = item;
      expect(customer.createdAt.getTime()).toBeLessThanOrEqual(item.failedAt.getTime());
      expect(customer.lifetimeValuePaise).toBeGreaterThanOrEqual(0);
      expect(customer.successfulPaymentsCount).toBeGreaterThanOrEqual(0);
      if (customer.lastSuccessfulPaymentAt) {
        expect(customer.lastSuccessfulPaymentAt.getTime()).toBeLessThanOrEqual(item.failedAt.getTime());
        expect(customer.successfulPaymentsCount).toBeGreaterThan(0);
      } else {
        expect(customer.successfulPaymentsCount).toBe(0);
      }
      expect(item.amountPaise).toBeGreaterThan(0);
      expect(Number.isInteger(item.amountPaise)).toBe(true);
    }
  });

  it("gives every payment and customer a distinct identifier", () => {
    const dataset = generateDataset({ size: 120, seed: SEED, detectedAt: START });
    expect(new Set(dataset.map((c) => c.paymentId)).size).toBe(dataset.length);
    expect(new Set(dataset.map((c) => c.customer.id)).size).toBe(dataset.length);
  });

  it("reports a composition that accounts for every case and every rupee", () => {
    const dataset = generateDataset({ size: 50, seed: SEED, detectedAt: START });
    const mix = describeMix(dataset);
    expect(mix.reduce((sum, e) => sum + e.cases, 0)).toBe(dataset.length);
    expect(mix.reduce((sum, e) => sum + e.amountPaise, 0)).toBe(totalAtRiskPaise(dataset));
  });
});

describe("the comparison baselines", () => {
  it("never claims a model made its decision", async () => {
    for (const baseline of [
      new NoInterventionBaseline(),
      new AlwaysRetryOnceBaseline(),
      new AlwaysPaymentLinkBaseline(),
    ]) {
      const result = await baseline.decide(context());
      expect(result.source).toBe(DecisionSource.BASELINE);
      expect(result.model).toBeNull();
      expect(result.decision.reasoningSummary).toMatch(/^Fixed baseline:/);
    }
  });

  it("does nothing, in the no-intervention arm", async () => {
    const first = await new NoInterventionBaseline().decide(context({ cycle: 1 }));
    const later = await new NoInterventionBaseline().decide(context({ cycle: 4 }));
    expect(first.decision.recommendedAction).toBe(RecoveryAction.STOP);
    expect(later.decision.recommendedAction).toBe(RecoveryAction.STOP);
  });

  it("retries exactly once, counted by cycle rather than by executed action", async () => {
    const baseline = new AlwaysRetryOnceBaseline();
    const first = await baseline.decide(context({ cycle: 1 }));
    expect(first.decision.recommendedAction).toBe(RecoveryAction.RETRY_PAYMENT);

    // A retry the policy engine refused still consumed the single attempt, so
    // the second cycle stops rather than proposing the same thing forever.
    const second = await baseline.decide(context({ cycle: 2, retriesAttempted: 0 }));
    expect(second.decision.recommendedAction).toBe(RecoveryAction.STOP);
  });

  it("states enough confidence to reach the action it names", async () => {
    // Below the financial-action floor the policy engine would quietly
    // downgrade a retry to a payment link, and the arm would stop being the
    // baseline it claims to be.
    const result = await new AlwaysRetryOnceBaseline().decide(context({ cycle: 1 }));
    expect(result.decision.confidence).toBeGreaterThanOrEqual(
      DEFAULT_POLICY.minimumFinancialActionConfidence,
    );
  });

  it("sends one link, then waits for the customer instead of closing the case", async () => {
    const baseline = new AlwaysPaymentLinkBaseline();

    const first = await baseline.decide(context({ cycle: 1 }));
    expect(first.decision.recommendedAction).toBe(RecoveryAction.CREATE_PAYMENT_LINK);

    const waiting = await baseline.decide(context({ cycle: 2, paymentLinksCreated: 1 }));
    expect(waiting.decision.recommendedAction).toBe(RecoveryAction.WAIT);

    const expired = await baseline.decide(
      context({ cycle: 9, paymentLinksCreated: 1, hoursOpen: DEFAULT_POLICY.maximumRecoveryDurationHours }),
    );
    expect(expired.decision.recommendedAction).toBe(RecoveryAction.STOP);
  });
});

describe("the batch harness", () => {
  const dataset = generateDataset({ size: 12, seed: SEED, detectedAt: START });

  it("closes every case in the book", async () => {
    const result = await runArm({
      arm: "agent",
      decider: "heuristic",
      agent: new HeuristicRecoveryAgent(),
      dataset,
      seed: SEED,
      startAt: START,
    });

    expect(result.outcomes).toHaveLength(dataset.length);
    expect(result.hitRoundLimit).toBe(false);
    expect(result.openCasesAtEnd).toBe(0);
    for (const outcome of result.outcomes) {
      expect(isTerminal(outcome.finalState)).toBe(true);
    }
    // Nothing is left inside an active workflow, so nothing is still at risk.
    expect(result.snapshot.revenue.atRiskPaise).toBe(0);
  });

  it("replays identically for a deterministic decider", async () => {
    const run = () =>
      runArm({
        arm: "agent",
        decider: "heuristic",
        agent: new HeuristicRecoveryAgent(),
        dataset,
        seed: SEED,
        startAt: START,
      });

    const [a, b] = await Promise.all([run(), run()]);
    expect(b.snapshot.revenue.recoveredPaise).toBe(a.snapshot.revenue.recoveredPaise);
    expect(b.outcomes.map((o) => o.finalState)).toEqual(a.outcomes.map((o) => o.finalState));
    expect(b.outcomes.map((o) => o.recoveredAmountPaise)).toEqual(
      a.outcomes.map((o) => o.recoveredAmountPaise),
    );
  });

  it("counts recovered money once, and only for confirmed recoveries", async () => {
    const result = await runArm({
      arm: "agent",
      decider: "heuristic",
      agent: new HeuristicRecoveryAgent(),
      dataset,
      seed: SEED,
      startAt: START,
    });

    const recovered = result.outcomes.filter((o) => o.recovered);
    const sum = recovered.reduce((total, o) => total + o.recoveredAmountPaise, 0);

    expect(result.snapshot.revenue.recoveredPaise).toBe(sum);
    for (const outcome of recovered) {
      // The amount recovered is the amount that was at risk. Never more.
      expect(outcome.recoveredAmountPaise).toBe(outcome.amountPaise);
      expect(outcome.finalState).toBe(RecoveryState.RECOVERED);
    }
    for (const outcome of result.outcomes.filter((o) => !o.recovered)) {
      expect(outcome.recoveredAmountPaise).toBe(0);
    }
  });

  it("recovers nothing and contacts nobody in the no-intervention arm", async () => {
    const result = await runArm({
      arm: "no-intervention",
      decider: "fixed rule",
      agent: new NoInterventionBaseline(),
      dataset,
      seed: SEED,
      startAt: START,
    });

    expect(result.snapshot.revenue.recoveredPaise).toBe(0);
    expect(result.outcomes.every((o) => !o.recovered)).toBe(true);
    expect(result.snapshot.interventions.attempted).toBe(0);
    expect(result.outcomes.flatMap((o) => o.actions)).toEqual([]);
  });

  it("gives every arm the same book and the same coin flips", async () => {
    // Two different strategies, same seed: the cases and amounts they face are
    // identical, so any difference in what they recover is theirs.
    const [retry, link] = await Promise.all([
      runArm({
        arm: "always-retry-once",
        decider: "fixed rule",
        agent: new AlwaysRetryOnceBaseline(),
        dataset,
        seed: SEED,
        startAt: START,
      }),
      runArm({
        arm: "always-payment-link",
        decider: "fixed rule",
        agent: new AlwaysPaymentLinkBaseline(),
        dataset,
        seed: SEED,
        startAt: START,
      }),
    ]);

    expect(retry.outcomes.map((o) => o.amountPaise)).toEqual(link.outcomes.map((o) => o.amountPaise));
    expect(retry.outcomes.map((o) => o.failureCode)).toEqual(link.outcomes.map((o) => o.failureCode));
    expect(retry.outcomes.every((o) => !o.actions.includes(RecoveryAction.CREATE_PAYMENT_LINK))).toBe(true);
    expect(link.outcomes.every((o) => !o.actions.includes(RecoveryAction.RETRY_PAYMENT))).toBe(true);
  });

  it("separates refused proposals from escalate and stop verdicts", async () => {
    const result = await runArm({
      arm: "no-intervention",
      decider: "fixed rule",
      agent: new NoInterventionBaseline(),
      dataset,
      seed: SEED,
      startAt: START,
    });

    // This arm proposes STOP and nothing else, so the policy engine refuses
    // nothing: every unapproved verdict is a diversion it decided itself.
    expect(result.genuineBlocks).toBe(0);
    expect(result.diversions).toBeGreaterThan(0);
    expect(result.genuineBlocks + result.diversions).toBe(
      result.snapshot.policy.blocked,
    );
  });
});

describe("the comparison report", () => {
  const outcome = (over: Partial<CaseOutcome> = {}): CaseOutcome => ({
    caseId: "case_1",
    paymentId: "pay_1",
    archetype: Archetype.TRANSIENT_ISSUER,
    amountPaise: 249_900,
    failureCode: FailureCode.ISSUER_UNAVAILABLE,
    finalState: RecoveryState.STOPPED,
    recovered: false,
    recoveredAmountPaise: 0,
    hoursToRecovery: null,
    cycles: 1,
    actionsExecuted: 0,
    actions: [],
    policyBlocks: 0,
    blockRules: [],
    terminalRule: null,
    lastDecisionSource: "heuristic_fallback",
    lastReasoningSummary: null,
    ...over,
  });

  it("rates recovery over the whole book, not over the cases a strategy chose to touch", async () => {
    const dataset = generateDataset({ size: 12, seed: SEED, detectedAt: START });
    const result = await runArm({
      arm: "agent",
      decider: "heuristic",
      agent: new HeuristicRecoveryAgent(),
      dataset,
      seed: SEED,
      startAt: START,
    });

    const summary = summariseArm(result, totalAtRiskPaise(dataset));
    expect(summary.casesInBook).toBe(dataset.length);
    expect(summary.recoveryRateOverBook).toBeCloseTo(summary.recoveredCases / dataset.length, 10);
    // The conditional rate uses a smaller denominator, so it can only be higher.
    expect(summary.recoveryRateOverAttempts).toBeGreaterThanOrEqual(summary.recoveryRateOverBook);
  });

  it("measures uplift against the named reference arm", () => {
    const summaries = [
      { arm: "a", recoveredPaise: 0, recoveredCases: 0 },
      { arm: "b", recoveredPaise: 500, recoveredCases: 2 },
    ] as ReturnType<typeof summariseArm>[];

    const comparison = compare(summaries, "a");
    expect(comparison.upliftPaise.get("b")).toBe(500);
    expect(comparison.upliftCases.get("b")).toBe(2);
    expect(() => compare(summaries, "missing")).toThrow();
  });

  it("names the scenario a finished case demonstrates", () => {
    expect(
      scenariosFor(
        outcome({ recovered: true, finalState: RecoveryState.RECOVERED, actions: ["RETRY_PAYMENT"] }),
      ),
    ).toContain(Scenario.RECOVERED_BY_RETRY);

    expect(
      scenariosFor(
        outcome({
          recovered: true,
          finalState: RecoveryState.RECOVERED,
          actions: ["RETRY_PAYMENT", "CREATE_PAYMENT_LINK"],
        }),
      ),
    ).toContain(Scenario.RECOVERED_BY_LINK);

    expect(
      scenariosFor(outcome({ finalState: RecoveryState.STOPPED, actions: ["CREATE_PAYMENT_LINK"] })),
    ).toContain(Scenario.NO_CUSTOMER_RESPONSE);

    expect(scenariosFor(outcome({ finalState: RecoveryState.STOPPED }))).toContain(
      Scenario.NOT_PURSUED,
    );

    expect(
      scenariosFor(outcome({ finalState: RecoveryState.FAILED, actions: ["RETRY_PAYMENT"] })),
    ).toContain(Scenario.ATTEMPTS_EXHAUSTED);

    expect(scenariosFor(outcome({ policyBlocks: 2 }))).toContain(Scenario.POLICY_BLOCKED);
  });

  it("attributes an escalation to the amount whenever the amount alone would force it", () => {
    // The agent may propose ESCALATE itself, in which case the policy engine
    // agrees rather than diverting, and the rule code reads APPROVED. The
    // reason is still the amount.
    const highValue = outcome({
      finalState: RecoveryState.ESCALATED,
      amountPaise: DEFAULT_POLICY.escalationAmountThresholdPaise,
      terminalRule: "APPROVED",
    });
    expect(scenariosFor(highValue)).toContain(Scenario.ESCALATED_HIGH_VALUE);

    const lowConfidence = outcome({
      finalState: RecoveryState.ESCALATED,
      terminalRule: "LOW_CONFIDENCE_ESCALATION",
    });
    expect(scenariosFor(lowConfidence)).toContain(Scenario.ESCALATED_LOW_CONFIDENCE);

    const judgement = outcome({ finalState: RecoveryState.ESCALATED, terminalRule: "APPROVED" });
    expect(scenariosFor(judgement)).toContain(Scenario.ESCALATED_BY_JUDGEMENT);
  });
});

function context(
  overrides: {
    cycle?: number;
    retriesAttempted?: number;
    paymentLinksCreated?: number;
    hoursOpen?: number;
  } = {},
): RecoveryContext {
  const now = new Date("2026-08-30T12:00:00.000Z");
  const openedAt = new Date(now.getTime() - (overrides.hoursOpen ?? 1) * 3_600_000);

  return buildRecoveryContext({
    recoveryCase: {
      id: "case_1",
      paymentId: "pay_1",
      customerId: "cust_1",
      amountPaise: 249_900,
      currency: "INR",
      state: RecoveryState.ANALYZING,
      diagnosis: null,
      recoverability: null,
      confidence: null,
      cycleCount: overrides.cycle ?? 1,
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
      amountPaise: 249_900,
      currency: "INR",
      status: PaymentStatus.FAILED,
      method: PaymentMethod.CARD,
      failureCode: FailureCode.ISSUER_UNAVAILABLE,
      failureReasonRaw: "Issuer bank is temporarily unavailable",
      attemptNumber: 1,
      provider: ProviderKind.SIMULATED,
      createdAt: openedAt,
      updatedAt: openedAt,
    },
    customer: {
      id: "cust_1",
      name: "Asha Menon",
      email: "asha.menon1@example.test",
      createdAt: new Date("2025-08-30T10:00:00.000Z"),
      lifetimeValuePaise: 1_000_000,
      successfulPaymentsCount: 4,
      failedPaymentsCount: 1,
      lastSuccessfulPaymentAt: new Date("2026-07-30T10:00:00.000Z"),
    },
    cycle: overrides.cycle ?? 1,
    retriesAttempted: overrides.retriesAttempted ?? 0,
    remindersSent: 0,
    paymentLinksCreated: overrides.paymentLinksCreated ?? 0,
    lastCustomerContactAt: null,
    lastRetryAt: null,
    priorActions: [],
    policy: DEFAULT_POLICY,
    now,
  });
}
