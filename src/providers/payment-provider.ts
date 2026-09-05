import type { FailureCode, PaymentStatus, ProviderKind, RecoveryAction } from "@/core/domain/enums";
import type { Paise } from "@/core/domain/money";

export interface PaymentResult {
  success: boolean;
  status: PaymentStatus;
  externalReference: string | null;
  failureCode: FailureCode | null;
  failureReasonRaw: string | null;
  provider: ProviderKind;
  raw: Record<string, unknown>;
}

export interface PaymentLinkResult {
  success: boolean;
  linkId: string | null;
  url: string | null;
  provider: ProviderKind;
  raw: Record<string, unknown>;
  error: string | null;
}

export interface PaymentLinkStatus {
  paid: boolean;
  paidAt: Date | null;
  amountPaise: Paise | null;
  externalReference: string | null;
}

/**
 * The boundary between recovery logic and any real payment provider.
 *
 * Recovery decisions are expressed entirely in these four operations, so the
 * simulated provider and Razorpay test mode are interchangeable and the core
 * never learns which one it is talking to. Every implementation reports its
 * `kind`, and that value is persisted on each action — a simulated outcome is
 * never recorded as though a real API produced it.
 */
export interface PaymentProvider {
  readonly kind: ProviderKind;

  /**
   * Re-attempt a failed payment on the original instrument.
   *
   * Note: this is not implementable against live Razorpay, which has no
   * server-initiated re-charge without a saved token or active mandate. The
   * Razorpay provider says so explicitly rather than faking it.
   */
  retryPayment(params: {
    paymentId: string;
    amountPaise: Paise;
    currency: string;
    idempotencyKey: string;
  }): Promise<PaymentResult>;

  createRecoveryLink(params: {
    caseId: string;
    paymentId: string;
    customerId: string;
    customerName: string;
    customerEmail: string;
    amountPaise: Paise;
    currency: string;
    idempotencyKey: string;
    expiresAt: Date;
  }): Promise<PaymentLinkResult>;

  getPaymentStatus(paymentId: string): Promise<PaymentStatus>;

  getPaymentLinkStatus(linkId: string): Promise<PaymentLinkStatus>;

  /** Called when a reminder goes out, so a provider may model its effect. */
  notePaymentLinkReminder?(linkId: string): void;

  /**
   * Which provider actually carries out a given action.
   *
   * A composite routes different actions to different backends, and the action
   * record has to name the one that really ran — a simulated retry must never
   * be filed under a live integration. Defaults to `kind`.
   */
  kindFor?(action: RecoveryAction): ProviderKind;
}

export class ProviderUnsupportedError extends Error {
  constructor(provider: ProviderKind, operation: string, why: string) {
    super(`${provider} cannot perform ${operation}: ${why}`);
    this.name = "ProviderUnsupportedError";
  }
}
