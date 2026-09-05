import {
  FINANCIAL_ACTIONS,
  HARD_DECLINE_CODES,
  RecoveryAction,
  isTerminal,
} from "@/core/domain/enums";
import type { FailureCode } from "@/core/domain/enums";
import type { RecoveryCase, RecoveryDecision } from "@/core/domain/types";
import { hoursBetween, minutesBetween } from "@/core/clock";
import type { RecoveryPolicy } from "@/core/policy/policy-config";
import { PolicyRuleCode } from "@/core/policy/policy-config";

/**
 * Facts the policy engine enforces against.
 *
 * Deliberately re-derived from the database by the caller rather than taken
 * from the RecoveryContext the agent saw. The agent's view of its own budget is
 * advisory; enforcement reads the ledger. A model that misreads the summary it
 * was shown — or is instructed to ignore it — changes nothing here.
 */
export interface PolicyFacts {
  retriesAttempted: number;
  remindersSent: number;
  paymentLinksCreated: number;
  customerMessagesSent: number;
  hasOpenPaymentLink: boolean;
  lastRetryAt: Date | null;
  lastCustomerContactAt: Date | null;
  actionsInTrailingDay: number;
  failureCode: FailureCode;
}

export const PolicyOutcome = {
  /** Execute `effectiveAction`. */
  APPROVED: "APPROVED",
  /** Nothing may be done right now; the case waits. */
  BLOCKED: "BLOCKED",
  /** Hand to a human. */
  ESCALATE: "ESCALATE",
  /** Recovery ends here. */
  STOP: "STOP",
} as const;
export type PolicyOutcome = (typeof PolicyOutcome)[keyof typeof PolicyOutcome];

/**
 * A permission slip for exactly one action on exactly one case.
 *
 * The constructor is private, so an instance can only come from `mint` below,
 * which is module-private and reachable only at the end of `evaluate`. The
 * executor accepts nothing else and verifies with `instanceof`, so an agent
 * decision cannot reach an external API without passing through this file —
 * not as a matter of discipline, but because no other code can build the value
 * the executor requires.
 */
export class ApprovedAction {
  private constructor(
    readonly caseId: string,
    readonly cycle: number,
    readonly action: RecoveryAction,
    readonly ruleCode: PolicyRuleCode,
    readonly reason: string,
    readonly restrictions: readonly string[],
  ) {
    Object.freeze(this);
  }

  /** @internal — only `evaluate` may call this. */
  static mint(params: {
    caseId: string;
    cycle: number;
    action: RecoveryAction;
    ruleCode: PolicyRuleCode;
    reason: string;
    restrictions: readonly string[];
  }): ApprovedAction {
    return new ApprovedAction(
      params.caseId,
      params.cycle,
      params.action,
      params.ruleCode,
      params.reason,
      params.restrictions,
    );
  }
}

export interface PolicyResult {
  outcome: PolicyOutcome;
  originalAction: RecoveryAction;
  /** What will actually happen. Differs from `originalAction` on an override. */
  effectiveAction: RecoveryAction | null;
  ruleCode: PolicyRuleCode;
  reason: string;
  restrictions: string[];
  /** Non-null if and only if `outcome === APPROVED`. */
  approvedAction: ApprovedAction | null;
  /** True when the policy replaced the agent's choice. Surfaced in the UI. */
  overridden: boolean;
}

export interface PolicyInput {
  recoveryCase: RecoveryCase;
  decision: RecoveryDecision;
  facts: PolicyFacts;
  policy: RecoveryPolicy;
  now: Date;
}

type Rule = (input: PolicyInput) => Omit<PolicyResult, "approvedAction" | "overridden"> | null;

const block = (
  action: RecoveryAction,
  ruleCode: PolicyRuleCode,
  reason: string,
  restrictions: string[] = [],
): Omit<PolicyResult, "approvedAction" | "overridden"> => ({
  outcome: PolicyOutcome.BLOCKED,
  originalAction: action,
  effectiveAction: null,
  ruleCode,
  reason,
  restrictions,
});

const divert = (
  outcome: typeof PolicyOutcome.ESCALATE | typeof PolicyOutcome.STOP,
  action: RecoveryAction,
  ruleCode: PolicyRuleCode,
  reason: string,
): Omit<PolicyResult, "approvedAction" | "overridden"> => ({
  outcome,
  originalAction: action,
  effectiveAction: outcome === PolicyOutcome.ESCALATE ? RecoveryAction.ESCALATE : RecoveryAction.STOP,
  ruleCode,
  reason,
  restrictions: [],
});

/**
 * Ordered rules. The first one that fires decides the outcome.
 *
 * Order is deliberate: hard stops before overrides, overrides before
 * per-action limits, so a case that should not be touched at all is never
 * evaluated for whether its retry interval has elapsed.
 */
const RULES: readonly Rule[] = [
  // 1 — the case is already closed.
  ({ recoveryCase }) =>
    isTerminal(recoveryCase.state)
      ? divert(
          PolicyOutcome.STOP,
          RecoveryAction.STOP,
          PolicyRuleCode.CASE_TERMINAL,
          `Case is already in terminal state ${recoveryCase.state}`,
        )
      : null,

  // 2 — the recovery window has closed.
  ({ recoveryCase, decision, policy, now }) => {
    const hoursOpen = hoursBetween(recoveryCase.openedAt, now);
    return hoursOpen >= policy.maximumRecoveryDurationHours
      ? divert(
          PolicyOutcome.STOP,
          decision.recommendedAction,
          PolicyRuleCode.RECOVERY_WINDOW_EXPIRED,
          `Recovery window of ${policy.maximumRecoveryDurationHours}h expired (${hoursOpen.toFixed(1)}h open)`,
        )
      : null;
  },

  // 3 — system-wide kill switch.
  ({ decision, facts, policy }) =>
    facts.actionsInTrailingDay >= policy.globalDailyActionCap
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.GLOBAL_ACTION_CAP,
          `System-wide cap of ${policy.globalDailyActionCap} actions per 24h reached`,
        )
      : null,

  // 4 — the agent judged the revenue unrecoverable.
  ({ decision }) =>
    decision.recoverability === "NOT_RECOVERABLE"
      ? divert(
          PolicyOutcome.STOP,
          decision.recommendedAction,
          PolicyRuleCode.NOT_RECOVERABLE,
          "Assessed as not recoverable; no further attempts",
        )
      : null,

  // 5 — too small to be worth pursuing.
  ({ recoveryCase, decision, policy }) =>
    recoveryCase.amountPaise < policy.minimumRecoverableAmountPaise
      ? divert(
          PolicyOutcome.STOP,
          decision.recommendedAction,
          PolicyRuleCode.AMOUNT_BELOW_RECOVERY_THRESHOLD,
          `Amount is below the ${policy.minimumRecoverableAmountPaise} paise recovery threshold`,
        )
      : null,

  // 6 — high value: a human decides, whatever the agent proposed.
  ({ recoveryCase, decision, policy }) =>
    recoveryCase.amountPaise >= policy.escalationAmountThresholdPaise &&
    decision.recommendedAction !== RecoveryAction.ESCALATE
      ? divert(
          PolicyOutcome.ESCALATE,
          decision.recommendedAction,
          PolicyRuleCode.HIGH_VALUE_ESCALATION,
          `Amount is at or above the escalation threshold; requires human review`,
        )
      : null,

  // 7 — low confidence: escalate rather than guess. Never act harder to compensate.
  ({ decision, policy }) =>
    decision.confidence < policy.minimumConfidence &&
    decision.recommendedAction !== RecoveryAction.ESCALATE
      ? divert(
          PolicyOutcome.ESCALATE,
          decision.recommendedAction,
          PolicyRuleCode.LOW_CONFIDENCE_ESCALATION,
          `Confidence ${decision.confidence.toFixed(2)} is below the ${policy.minimumConfidence} floor`,
        )
      : null,

  // 8 — moving money demands more certainty than sending a message.
  ({ decision, facts, policy }) => {
    if (!FINANCIAL_ACTIONS.includes(decision.recommendedAction)) return null;
    if (decision.confidence >= policy.minimumFinancialActionConfidence) return null;
    const canOfferLink = !facts.hasOpenPaymentLink && facts.paymentLinksCreated < policy.maxPaymentLinks;
    return canOfferLink
      ? {
          outcome: PolicyOutcome.APPROVED,
          originalAction: decision.recommendedAction,
          effectiveAction: RecoveryAction.CREATE_PAYMENT_LINK,
          ruleCode: PolicyRuleCode.FINANCIAL_ACTION_CONFIDENCE,
          reason: `Confidence ${decision.confidence.toFixed(2)} is below the ${policy.minimumFinancialActionConfidence} floor for a payment retry; offering a payment link instead`,
          restrictions: ["downgraded from a financial action"],
        }
      : divert(
          PolicyOutcome.ESCALATE,
          decision.recommendedAction,
          PolicyRuleCode.FINANCIAL_ACTION_CONFIDENCE,
          `Confidence ${decision.confidence.toFixed(2)} is too low to retry and no payment link is available`,
        );
  },

  // 9 — retry budget.
  ({ decision, facts, policy }) =>
    decision.recommendedAction === RecoveryAction.RETRY_PAYMENT &&
    facts.retriesAttempted >= policy.maxPaymentRetries
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.RETRY_LIMIT_REACHED,
          `Maximum of ${policy.maxPaymentRetries} payment retries already attempted`,
        )
      : null,

  // 10 — retrying the same instrument cannot work for these failures.
  ({ decision, facts }) =>
    decision.recommendedAction === RecoveryAction.RETRY_PAYMENT &&
    HARD_DECLINE_CODES.includes(facts.failureCode)
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.RETRY_FUTILE_HARD_DECLINE,
          `${facts.failureCode} cannot be resolved by retrying; customer action is required`,
        )
      : null,

  // 11 — retry spacing.
  ({ decision, facts, policy, now }) => {
    if (decision.recommendedAction !== RecoveryAction.RETRY_PAYMENT) return null;
    if (facts.lastRetryAt === null) return null;
    const elapsed = minutesBetween(facts.lastRetryAt, now);
    return elapsed < policy.minimumRetryIntervalMinutes
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.RETRY_INTERVAL_NOT_ELAPSED,
          `Only ${elapsed.toFixed(0)} of ${policy.minimumRetryIntervalMinutes} minutes have passed since the last retry`,
        )
      : null;
  },

  // 12 — a customer may not be contacted without limit.
  ({ decision, facts, policy }) => {
    if (decision.recommendedAction !== RecoveryAction.SEND_REMINDER) return null;
    return facts.remindersSent >= policy.maxReminders
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.REMINDER_LIMIT_REACHED,
          `Maximum of ${policy.maxReminders} reminders already sent`,
        )
      : null;
  },

  // 13 — total contact ceiling across message types.
  ({ decision, facts, policy }) => {
    if (
      decision.recommendedAction !== RecoveryAction.SEND_REMINDER &&
      decision.recommendedAction !== RecoveryAction.CREATE_PAYMENT_LINK
    ) {
      return null;
    }
    return facts.customerMessagesSent >= policy.maxCustomerMessages
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.CUSTOMER_MESSAGE_LIMIT_REACHED,
          `Customer has already received the maximum of ${policy.maxCustomerMessages} messages for this case`,
        )
      : null;
  },

  // 14 — message spacing.
  ({ decision, facts, policy, now }) => {
    if (decision.recommendedAction !== RecoveryAction.SEND_REMINDER) return null;
    if (facts.lastCustomerContactAt === null) return null;
    const elapsed = hoursBetween(facts.lastCustomerContactAt, now);
    return elapsed < policy.minimumMessageIntervalHours
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.MESSAGE_INTERVAL_NOT_ELAPSED,
          `Only ${elapsed.toFixed(1)} of ${policy.minimumMessageIntervalHours} hours have passed since the last message`,
        )
      : null;
  },

  // 15 — never generate a second live payment link.
  ({ decision, facts }) =>
    decision.recommendedAction === RecoveryAction.CREATE_PAYMENT_LINK && facts.hasOpenPaymentLink
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.DUPLICATE_PAYMENT_LINK,
          "An unpaid payment link already exists for this case",
        )
      : null,

  // 16 — payment link budget.
  ({ decision, facts, policy }) =>
    decision.recommendedAction === RecoveryAction.CREATE_PAYMENT_LINK &&
    facts.paymentLinksCreated >= policy.maxPaymentLinks
      ? block(
          decision.recommendedAction,
          PolicyRuleCode.PAYMENT_LINK_LIMIT_REACHED,
          `Maximum of ${policy.maxPaymentLinks} payment link(s) already created`,
        )
      : null,
];

/**
 * Validate a proposed action against every rule.
 *
 * Pure and total: no I/O, no clock read, no randomness. The same inputs always
 * produce the same verdict, which is what makes the guardrails testable and
 * the audit trail meaningful.
 */
export function evaluate(input: PolicyInput): PolicyResult {
  for (const rule of RULES) {
    const verdict = rule(input);
    if (!verdict) continue;

    const overridden = verdict.effectiveAction !== verdict.originalAction;
    if (verdict.outcome === PolicyOutcome.APPROVED && verdict.effectiveAction) {
      return {
        ...verdict,
        overridden,
        approvedAction: ApprovedAction.mint({
          caseId: input.recoveryCase.id,
          cycle: input.recoveryCase.cycleCount,
          action: verdict.effectiveAction,
          ruleCode: verdict.ruleCode,
          reason: verdict.reason,
          restrictions: verdict.restrictions,
        }),
      };
    }
    return { ...verdict, overridden, approvedAction: null };
  }

  // No rule objected.
  const action = input.decision.recommendedAction;

  // ESCALATE and STOP are resolved here rather than executed — there is no
  // external call to make, so the case moves straight to its terminal state.
  if (action === RecoveryAction.ESCALATE) {
    return {
      outcome: PolicyOutcome.ESCALATE,
      originalAction: action,
      effectiveAction: RecoveryAction.ESCALATE,
      ruleCode: PolicyRuleCode.APPROVED,
      reason: input.decision.reasoningSummary,
      restrictions: [],
      approvedAction: null,
      overridden: false,
    };
  }
  if (action === RecoveryAction.STOP) {
    return {
      outcome: PolicyOutcome.STOP,
      originalAction: action,
      effectiveAction: RecoveryAction.STOP,
      ruleCode: PolicyRuleCode.APPROVED,
      reason: input.decision.reasoningSummary,
      restrictions: [],
      approvedAction: null,
      overridden: false,
    };
  }

  return {
    outcome: PolicyOutcome.APPROVED,
    originalAction: action,
    effectiveAction: action,
    ruleCode: PolicyRuleCode.APPROVED,
    reason: `No policy rule objects to ${action}`,
    restrictions: [],
    overridden: false,
    approvedAction: ApprovedAction.mint({
      caseId: input.recoveryCase.id,
      cycle: input.recoveryCase.cycleCount,
      action,
      ruleCode: PolicyRuleCode.APPROVED,
      reason: `No policy rule objects to ${action}`,
      restrictions: [],
    }),
  };
}
