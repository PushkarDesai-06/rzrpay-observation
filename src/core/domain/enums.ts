/**
 * Every bounded vocabulary in the system.
 *
 * These are declared as frozen `as const` objects rather than TypeScript
 * `enum`s so the runtime values can be handed straight to Zod and to the
 * agent's tool schema. That matters: the set of actions the model may choose
 * from is generated from the same constant the executor switches on, so the
 * two can never drift apart.
 */

/** Lifecycle of a recovery case. Transitions are governed by the state machine. */
export const RecoveryState = {
  DETECTED: "DETECTED",
  ANALYZING: "ANALYZING",
  RECOVERY_CANDIDATE: "RECOVERY_CANDIDATE",
  ACTION_PLANNED: "ACTION_PLANNED",
  POLICY_VALIDATED: "POLICY_VALIDATED",
  ACTION_EXECUTING: "ACTION_EXECUTING",
  WAITING_FOR_OUTCOME: "WAITING_FOR_OUTCOME",
  RECOVERED: "RECOVERED",
  FAILED: "FAILED",
  NOT_RECOVERABLE: "NOT_RECOVERABLE",
  BLOCKED_BY_POLICY: "BLOCKED_BY_POLICY",
  ESCALATED: "ESCALATED",
  STOPPED: "STOPPED",
} as const;
export type RecoveryState = (typeof RecoveryState)[keyof typeof RecoveryState];

/**
 * The complete set of interventions. The agent may select from these and
 * nothing else; anything outside this set fails schema validation before it
 * can reach the policy engine, let alone the executor.
 */
export const RecoveryAction = {
  RETRY_PAYMENT: "RETRY_PAYMENT",
  CREATE_PAYMENT_LINK: "CREATE_PAYMENT_LINK",
  SEND_REMINDER: "SEND_REMINDER",
  WAIT: "WAIT",
  ESCALATE: "ESCALATE",
  STOP: "STOP",
} as const;
export type RecoveryAction = (typeof RecoveryAction)[keyof typeof RecoveryAction];

/** Actions that move money or contact a customer, and so face stricter gates. */
export const FINANCIAL_ACTIONS: readonly RecoveryAction[] = [
  RecoveryAction.RETRY_PAYMENT,
];
export const CUSTOMER_CONTACT_ACTIONS: readonly RecoveryAction[] = [
  RecoveryAction.SEND_REMINDER,
  RecoveryAction.CREATE_PAYMENT_LINK,
];

/** Why the payment most likely failed. */
export const Diagnosis = {
  TEMPORARY_FAILURE: "TEMPORARY_FAILURE",
  CUSTOMER_ACTION_REQUIRED: "CUSTOMER_ACTION_REQUIRED",
  PAYMENT_METHOD_ISSUE: "PAYMENT_METHOD_ISSUE",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  TECHNICAL_FAILURE: "TECHNICAL_FAILURE",
  UNKNOWN: "UNKNOWN",
} as const;
export type Diagnosis = (typeof Diagnosis)[keyof typeof Diagnosis];

/** How likely the revenue is to be recovered at all. */
export const Recoverability = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  NOT_RECOVERABLE: "NOT_RECOVERABLE",
} as const;
export type Recoverability = (typeof Recoverability)[keyof typeof Recoverability];

/**
 * Which decider actually produced a decision.
 *
 * Recorded on every decision and surfaced in the UI. A heuristic decision is
 * never displayed as though the model made it.
 */
export const DecisionSource = {
  LLM: "llm",
  HEURISTIC_FALLBACK: "heuristic_fallback",
  FIXTURE: "fixture",
  /** A fixed comparison strategy in the evaluation harness. Never the agent. */
  BASELINE: "baseline",
} as const;
export type DecisionSource = (typeof DecisionSource)[keyof typeof DecisionSource];

/** Lifecycle of a single executed action. */
export const ActionStatus = {
  PENDING: "PENDING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  SKIPPED_DUPLICATE: "SKIPPED_DUPLICATE",
} as const;
export type ActionStatus = (typeof ActionStatus)[keyof typeof ActionStatus];

/** Inbound event types the system understands. */
export const EventType = {
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_SUCCEEDED: "PAYMENT_SUCCEEDED",
  PAYMENT_LINK_CREATED: "PAYMENT_LINK_CREATED",
  PAYMENT_LINK_PAID: "PAYMENT_LINK_PAID",
  RECOVERY_TIMEOUT: "RECOVERY_TIMEOUT",
  ACTION_FAILED: "ACTION_FAILED",
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** Status of a payment as reported by a provider. */
export const PaymentStatus = {
  CREATED: "CREATED",
  AUTHORIZED: "AUTHORIZED",
  CAPTURED: "CAPTURED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentMethod = {
  CARD: "CARD",
  UPI: "UPI",
  NETBANKING: "NETBANKING",
  WALLET: "WALLET",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

/**
 * Normalised failure codes.
 *
 * Providers report failure reasons as free text; the detection layer maps them
 * onto this closed set deterministically, so no policy rule ever has to parse
 * a provider's prose.
 */
export const FailureCode = {
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  CARD_EXPIRED: "CARD_EXPIRED",
  CARD_DECLINED: "CARD_DECLINED",
  INCORRECT_CVV: "INCORRECT_CVV",
  AUTHENTICATION_FAILED: "AUTHENTICATION_FAILED",
  ISSUER_UNAVAILABLE: "ISSUER_UNAVAILABLE",
  GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  PAYMENT_CANCELLED: "PAYMENT_CANCELLED",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  UNKNOWN: "UNKNOWN",
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/**
 * Failure codes where retrying the same instrument cannot plausibly succeed.
 * Retry is blocked deterministically for these; recovery needs the customer.
 */
export const HARD_DECLINE_CODES: readonly FailureCode[] = [
  FailureCode.CARD_EXPIRED,
  FailureCode.INCORRECT_CVV,
  FailureCode.PAYMENT_CANCELLED,
  FailureCode.AUTHENTICATION_FAILED,
];

/** Which provider actually carried out an action. Never inferred, always recorded. */
export const ProviderKind = {
  SIMULATED: "simulated",
  RAZORPAY_TEST: "razorpay_test",
  OUTBOX: "outbox",
  NONE: "none",
} as const;
export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];

export const TERMINAL_STATES: readonly RecoveryState[] = [
  RecoveryState.RECOVERED,
  RecoveryState.FAILED,
  RecoveryState.NOT_RECOVERABLE,
  RecoveryState.ESCALATED,
  RecoveryState.STOPPED,
];

export function isTerminal(state: RecoveryState): boolean {
  return TERMINAL_STATES.includes(state);
}
