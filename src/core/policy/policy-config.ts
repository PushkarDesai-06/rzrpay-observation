import type { Paise } from "@/core/domain/money";

/**
 * Deterministic limits that constrain every intervention.
 *
 * These are plain data, read by pure functions. The agent is shown a summary of
 * the remaining budget so it can propose something plausible, but it has no
 * ability to read, write or reason its way around the values here.
 */
export interface RecoveryPolicy {
  /** Hard ceiling on automated payment retries per case. */
  maxPaymentRetries: number;
  /** Reminder messages per case. */
  maxReminders: number;
  /** Payment links per case. */
  maxPaymentLinks: number;
  /** Total outbound messages a customer may receive per case. */
  maxCustomerMessages: number;

  minimumRetryIntervalMinutes: number;
  minimumMessageIntervalHours: number;

  /** Recovery is abandoned once a case has been open this long. */
  maximumRecoveryDurationHours: number;

  /** At or above this amount, a human decides. */
  escalationAmountThresholdPaise: Paise;
  /** Below this amount, pursuing recovery costs more than it returns. */
  minimumRecoverableAmountPaise: Paise;

  /** Below this confidence the agent does not act; it escalates. */
  minimumConfidence: number;
  /** Money-moving actions demand more certainty than messages do. */
  minimumFinancialActionConfidence: number;

  /** System-wide ceiling on actions in a rolling 24h window. */
  globalDailyActionCap: number;
}

export const DEFAULT_POLICY: Readonly<RecoveryPolicy> = Object.freeze({
  maxPaymentRetries: 3,
  maxReminders: 2,
  maxPaymentLinks: 1,
  maxCustomerMessages: 3,

  minimumRetryIntervalMinutes: 30,
  minimumMessageIntervalHours: 24,

  maximumRecoveryDurationHours: 72,

  escalationAmountThresholdPaise: 2_500_000, // ₹25,000
  minimumRecoverableAmountPaise: 5_000, //      ₹50

  minimumConfidence: 0.6,
  minimumFinancialActionConfidence: 0.75,

  globalDailyActionCap: 500,
});

/**
 * Machine-readable identifier for whichever rule decided an evaluation.
 * Persisted on every verdict, which is what makes "why was this blocked?"
 * answerable by query rather than by reading prose.
 */
export const PolicyRuleCode = {
  APPROVED: "APPROVED",

  CASE_TERMINAL: "CASE_TERMINAL",
  RECOVERY_WINDOW_EXPIRED: "RECOVERY_WINDOW_EXPIRED",
  GLOBAL_ACTION_CAP: "GLOBAL_ACTION_CAP",

  HIGH_VALUE_ESCALATION: "HIGH_VALUE_ESCALATION",
  LOW_CONFIDENCE_ESCALATION: "LOW_CONFIDENCE_ESCALATION",
  FINANCIAL_ACTION_CONFIDENCE: "FINANCIAL_ACTION_CONFIDENCE",

  RETRY_LIMIT_REACHED: "RETRY_LIMIT_REACHED",
  RETRY_INTERVAL_NOT_ELAPSED: "RETRY_INTERVAL_NOT_ELAPSED",
  RETRY_FUTILE_HARD_DECLINE: "RETRY_FUTILE_HARD_DECLINE",

  REMINDER_LIMIT_REACHED: "REMINDER_LIMIT_REACHED",
  MESSAGE_INTERVAL_NOT_ELAPSED: "MESSAGE_INTERVAL_NOT_ELAPSED",
  CUSTOMER_MESSAGE_LIMIT_REACHED: "CUSTOMER_MESSAGE_LIMIT_REACHED",

  DUPLICATE_PAYMENT_LINK: "DUPLICATE_PAYMENT_LINK",
  PAYMENT_LINK_LIMIT_REACHED: "PAYMENT_LINK_LIMIT_REACHED",

  AMOUNT_BELOW_RECOVERY_THRESHOLD: "AMOUNT_BELOW_RECOVERY_THRESHOLD",
  NOT_RECOVERABLE: "NOT_RECOVERABLE",
} as const;
export type PolicyRuleCode = (typeof PolicyRuleCode)[keyof typeof PolicyRuleCode];
