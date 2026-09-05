import {
  Diagnosis,
  FailureCode,
  Recoverability,
  RecoveryAction,
} from "@/core/domain/enums";
import type { RecoveryContext } from "@/core/context/recovery-context";
import type { RecoveryDecision } from "@/core/domain/types";

/**
 * Deterministic decision rules over the failure code and case history.
 *
 * Two jobs. It is the fallback when the model is unavailable or returns
 * something invalid, so a provider outage degrades the system instead of
 * stopping it. It is also the rule-based arm of the baseline comparison, which
 * is the honest way to ask whether the model is earning its place.
 *
 * Pure: same context in, same decision out, no clock and no I/O.
 */

interface Branch {
  diagnosis: Diagnosis;
  recoverability: Recoverability;
  confidence: number;
  /** Probability of recovery used for expected value. */
  successProbability: number;
}

const BRANCHES: Readonly<Record<FailureCode, Branch>> = Object.freeze({
  [FailureCode.ISSUER_UNAVAILABLE]: {
    diagnosis: Diagnosis.TEMPORARY_FAILURE,
    recoverability: Recoverability.HIGH,
    confidence: 0.88,
    successProbability: 0.65,
  },
  [FailureCode.GATEWAY_TIMEOUT]: {
    diagnosis: Diagnosis.TECHNICAL_FAILURE,
    recoverability: Recoverability.HIGH,
    confidence: 0.85,
    successProbability: 0.6,
  },
  [FailureCode.NETWORK_ERROR]: {
    diagnosis: Diagnosis.TECHNICAL_FAILURE,
    recoverability: Recoverability.HIGH,
    confidence: 0.82,
    successProbability: 0.58,
  },
  [FailureCode.INSUFFICIENT_FUNDS]: {
    diagnosis: Diagnosis.INSUFFICIENT_FUNDS,
    recoverability: Recoverability.MEDIUM,
    confidence: 0.8,
    successProbability: 0.35,
  },
  [FailureCode.CARD_DECLINED]: {
    diagnosis: Diagnosis.PAYMENT_METHOD_ISSUE,
    recoverability: Recoverability.MEDIUM,
    confidence: 0.72,
    successProbability: 0.3,
  },
  [FailureCode.LIMIT_EXCEEDED]: {
    diagnosis: Diagnosis.CUSTOMER_ACTION_REQUIRED,
    recoverability: Recoverability.MEDIUM,
    confidence: 0.76,
    successProbability: 0.32,
  },
  [FailureCode.CARD_EXPIRED]: {
    diagnosis: Diagnosis.PAYMENT_METHOD_ISSUE,
    recoverability: Recoverability.MEDIUM,
    confidence: 0.9,
    successProbability: 0.4,
  },
  [FailureCode.INCORRECT_CVV]: {
    diagnosis: Diagnosis.CUSTOMER_ACTION_REQUIRED,
    recoverability: Recoverability.MEDIUM,
    confidence: 0.84,
    successProbability: 0.38,
  },
  [FailureCode.AUTHENTICATION_FAILED]: {
    diagnosis: Diagnosis.CUSTOMER_ACTION_REQUIRED,
    recoverability: Recoverability.MEDIUM,
    confidence: 0.78,
    successProbability: 0.36,
  },
  [FailureCode.PAYMENT_CANCELLED]: {
    diagnosis: Diagnosis.CUSTOMER_ACTION_REQUIRED,
    recoverability: Recoverability.LOW,
    confidence: 0.7,
    successProbability: 0.18,
  },
  [FailureCode.UNKNOWN]: {
    diagnosis: Diagnosis.UNKNOWN,
    recoverability: Recoverability.LOW,
    // Deliberately below the escalation floor: an unexplained failure is
    // exactly the case a human should look at, not one to guess at.
    confidence: 0.45,
    successProbability: 0.2,
  },
});

/** Customer history nudges the odds, within bounds. */
function adjustForHistory(base: number, context: RecoveryContext): number {
  let probability = base;
  if (context.customer.hasEverPaidSuccessfully) probability += 0.1;
  if (context.customer.successfulPaymentsCount >= 5) probability += 0.05;
  if (context.customer.failedPaymentsCount > context.customer.successfulPaymentsCount) {
    probability -= 0.1;
  }
  if (context.history.retriesAttempted >= 2) probability -= 0.15;
  return Math.min(0.95, Math.max(0.02, probability));
}

function selectAction(context: RecoveryContext, branch: Branch): RecoveryAction {
  const { budget, history } = context;

  if (budget.hoursLeftInRecoveryWindow <= 0) return RecoveryAction.STOP;
  if (budget.aboveEscalationThreshold) return RecoveryAction.ESCALATE;

  // A retry can only help when the instrument itself could plausibly work.
  const retryViable =
    !budget.retryLikelyFutile && budget.retriesRemaining > 0 && branch.successProbability >= 0.3;

  if (retryViable) {
    return budget.retryIntervalElapsed ? RecoveryAction.RETRY_PAYMENT : RecoveryAction.WAIT;
  }

  // Recovery now needs the customer. Offer a link first, then chase it once.
  if (budget.paymentLinksRemaining > 0) return RecoveryAction.CREATE_PAYMENT_LINK;

  if (history.paymentLinksCreated > 0 && budget.remindersRemaining > 0) {
    return budget.messageIntervalElapsed ? RecoveryAction.SEND_REMINDER : RecoveryAction.WAIT;
  }

  return RecoveryAction.STOP;
}

export function decideHeuristically(context: RecoveryContext): RecoveryDecision {
  const branch = BRANCHES[context.payment.failureCode] ?? BRANCHES[FailureCode.UNKNOWN];
  const probability = adjustForHistory(branch.successProbability, context);
  const action = selectAction(context, branch);

  const recoverability =
    probability < 0.1 ? Recoverability.NOT_RECOVERABLE : branch.recoverability;

  return {
    diagnosis: branch.diagnosis,
    recoverability,
    confidence: branch.confidence,
    recommendedAction: action,
    reasoningSummary: buildSummary(context, branch, action, probability),
    expectedValuePaise: Math.round(context.payment.amountPaise * probability),
  };
}

function buildSummary(
  context: RecoveryContext,
  branch: Branch,
  action: RecoveryAction,
  probability: number,
): string {
  const history = context.customer.hasEverPaidSuccessfully
    ? `${context.customer.successfulPaymentsCount} prior successful payment(s)`
    : "no prior successful payments";
  const odds = `${Math.round(probability * 100)}% estimated recovery odds`;
  return `Rule-based: ${context.payment.failureCode} classified as ${branch.diagnosis}; customer has ${history}; ${context.history.retriesAttempted} retries so far; ${odds}; selected ${action}.`;
}
