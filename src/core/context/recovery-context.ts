import type { FailureCode, PaymentMethod, RecoveryAction, RecoveryState } from "@/core/domain/enums";
import { HARD_DECLINE_CODES } from "@/core/domain/enums";
import type { Paise } from "@/core/domain/money";
import { formatINR } from "@/core/domain/money";
import { hoursBetween } from "@/core/clock";
import type { Customer, Payment, RecoveryCase } from "@/core/domain/types";
import type { RecoveryPolicy } from "@/core/policy/policy-config";

export interface PriorAction {
  action: RecoveryAction;
  at: string;
  status: string;
  outcome: string | null;
}

/**
 * Everything the agent is allowed to know.
 *
 * Assembled deterministically from what the system actually holds. The agent
 * sees this object and nothing else — no free-text notes, no external lookups —
 * which is what keeps it from inventing customer facts.
 */
export interface RecoveryContext {
  caseId: string;
  state: RecoveryState;
  cycle: number;

  payment: {
    amountPaise: Paise;
    amountFormatted: string;
    currency: string;
    method: PaymentMethod;
    failureCode: FailureCode;
    failureReasonRaw: string | null;
    attemptNumber: number;
    hoursSinceFailure: number;
  };

  customer: {
    tenureDays: number;
    lifetimeValuePaise: Paise;
    lifetimeValueFormatted: string;
    successfulPaymentsCount: number;
    failedPaymentsCount: number;
    daysSinceLastSuccessfulPayment: number | null;
    hasEverPaidSuccessfully: boolean;
  };

  history: {
    retriesAttempted: number;
    remindersSent: number;
    paymentLinksCreated: number;
    hoursSinceLastCustomerContact: number | null;
    priorActions: PriorAction[];
  };

  /**
   * Advisory only.
   *
   * Shown so the agent proposes something that stands a chance of being
   * approved rather than repeatedly suggesting exhausted actions. The policy
   * engine re-derives all of this from the database at validation time and
   * ignores whatever the agent believed — so a model that misreads this
   * summary, or is told to disregard it, changes nothing about what executes.
   */
  budget: {
    retriesRemaining: number;
    remindersRemaining: number;
    paymentLinksRemaining: number;
    hoursLeftInRecoveryWindow: number;
    retryIntervalElapsed: boolean;
    messageIntervalElapsed: boolean;
    retryLikelyFutile: boolean;
    aboveEscalationThreshold: boolean;
  };
}

export interface ContextInputs {
  recoveryCase: RecoveryCase;
  payment: Payment;
  customer: Customer;
  cycle: number;
  retriesAttempted: number;
  remindersSent: number;
  paymentLinksCreated: number;
  lastCustomerContactAt: Date | null;
  lastRetryAt: Date | null;
  priorActions: PriorAction[];
  policy: RecoveryPolicy;
  now: Date;
}

const days = (from: Date, to: Date): number => hoursBetween(from, to) / 24;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Pure assembly. No I/O, no clock reads — `now` is supplied by the caller. */
export function buildRecoveryContext(input: ContextInputs): RecoveryContext {
  const { recoveryCase, payment, customer, policy, now } = input;

  const failureCode = payment.failureCode ?? ("UNKNOWN" as FailureCode);
  const hoursOpen = hoursBetween(recoveryCase.openedAt, now);

  const retryIntervalElapsed =
    input.lastRetryAt === null ||
    hoursBetween(input.lastRetryAt, now) * 60 >= policy.minimumRetryIntervalMinutes;

  const messageIntervalElapsed =
    input.lastCustomerContactAt === null ||
    hoursBetween(input.lastCustomerContactAt, now) >= policy.minimumMessageIntervalHours;

  return {
    caseId: recoveryCase.id,
    state: recoveryCase.state,
    cycle: input.cycle,

    payment: {
      amountPaise: recoveryCase.amountPaise,
      amountFormatted: formatINR(recoveryCase.amountPaise),
      currency: recoveryCase.currency,
      method: payment.method,
      failureCode,
      failureReasonRaw: payment.failureReasonRaw,
      attemptNumber: payment.attemptNumber,
      hoursSinceFailure: round2(hoursBetween(payment.createdAt, now)),
    },

    customer: {
      tenureDays: Math.max(0, Math.floor(days(customer.createdAt, now))),
      lifetimeValuePaise: customer.lifetimeValuePaise,
      lifetimeValueFormatted: formatINR(customer.lifetimeValuePaise),
      successfulPaymentsCount: customer.successfulPaymentsCount,
      failedPaymentsCount: customer.failedPaymentsCount,
      daysSinceLastSuccessfulPayment: customer.lastSuccessfulPaymentAt
        ? round2(days(customer.lastSuccessfulPaymentAt, now))
        : null,
      hasEverPaidSuccessfully: customer.successfulPaymentsCount > 0,
    },

    history: {
      retriesAttempted: input.retriesAttempted,
      remindersSent: input.remindersSent,
      paymentLinksCreated: input.paymentLinksCreated,
      hoursSinceLastCustomerContact: input.lastCustomerContactAt
        ? round2(hoursBetween(input.lastCustomerContactAt, now))
        : null,
      priorActions: input.priorActions,
    },

    budget: {
      retriesRemaining: Math.max(0, policy.maxPaymentRetries - input.retriesAttempted),
      remindersRemaining: Math.max(0, policy.maxReminders - input.remindersSent),
      paymentLinksRemaining: Math.max(0, policy.maxPaymentLinks - input.paymentLinksCreated),
      hoursLeftInRecoveryWindow: round2(Math.max(0, policy.maximumRecoveryDurationHours - hoursOpen)),
      retryIntervalElapsed,
      messageIntervalElapsed,
      retryLikelyFutile: HARD_DECLINE_CODES.includes(failureCode),
      aboveEscalationThreshold:
        recoveryCase.amountPaise >= policy.escalationAmountThresholdPaise,
    },
  };
}
