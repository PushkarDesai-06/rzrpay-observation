import Razorpay from "razorpay";
import { createHash } from "node:crypto";
import { PaymentStatus, ProviderKind, RecoveryAction } from "@/core/domain/enums";
import type { Paise } from "@/core/domain/money";
import {
  ProviderUnsupportedError,
  type PaymentLinkResult,
  type PaymentLinkStatus,
  type PaymentProvider,
  type PaymentResult,
} from "@/providers/payment-provider";

export interface RazorpayProviderOptions {
  keyId: string;
  keySecret: string;
  /** Where a paying customer lands afterwards. Optional. */
  callbackUrl?: string | undefined;
  /** Payment links expire this many hours after creation. Razorpay minimum ~15 min. */
  linkExpiryHours?: number;
}

/**
 * Razorpay in TEST MODE.
 *
 * Test-mode credentials do not move real money and do not affect a merchant's
 * live transactions. Every action carried out here is recorded with
 * `provider: razorpay_test`, so a test-mode result is never displayed as a
 * production one.
 *
 * Two deliberate constraints:
 *
 * `retryPayment` is not implemented and says so. Razorpay has no server-side
 * re-charge of a failed payment without a saved token or an active mandate — a
 * "retry" there means the customer attempts checkout again. Simulating one
 * behind this class would misrepresent what the integration does, so the
 * composite provider routes retries to the simulator instead.
 *
 * Razorpay's own email and reminder features are switched OFF. Customer
 * communication is bounded by this system's policy engine; letting the payment
 * provider send its own reminders on its own schedule would route around those
 * limits entirely.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly kind = ProviderKind.RAZORPAY_TEST;
  private readonly client: Razorpay;
  private readonly options: Required<Omit<RazorpayProviderOptions, "callbackUrl">> & {
    callbackUrl: string | undefined;
  };

  /**
   * `client` is injectable so tests exercise this class without a network call.
   * Production callers pass options only.
   */
  constructor(options: RazorpayProviderOptions, client?: Razorpay) {
    if (!options.keyId.startsWith("rzp_test_")) {
      // A live key here would create real payment links for real customers.
      throw new Error(
        `Refusing to start: RAZORPAY_KEY_ID must be a test-mode key (rzp_test_...), got "${options.keyId.slice(0, 9)}..."`,
      );
    }
    this.client = client ?? new Razorpay({ key_id: options.keyId, key_secret: options.keySecret });
    this.options = {
      keyId: options.keyId,
      keySecret: options.keySecret,
      callbackUrl: options.callbackUrl,
      linkExpiryHours: options.linkExpiryHours ?? 48,
    };
  }

  retryPayment(): Promise<PaymentResult> {
    return Promise.reject(
      new ProviderUnsupportedError(
        this.kind,
        "retryPayment",
        "Razorpay cannot re-charge a failed payment server-side without a saved token or an active mandate",
      ),
    );
  }

  async createRecoveryLink(params: {
    caseId: string;
    paymentId: string;
    customerId: string;
    customerName: string;
    customerEmail: string;
    amountPaise: Paise;
    currency: string;
    idempotencyKey: string;
    expiresAt: Date;
  }): Promise<PaymentLinkResult> {
    try {
      const link = await this.client.paymentLink.create({
        amount: params.amountPaise,
        currency: params.currency,
        description: `Recovery for payment ${params.paymentId}`,
        // Razorpay rejects a duplicate reference_id, giving provider-side
        // idempotency on top of our own UNIQUE constraint.
        reference_id: toReferenceId(params.idempotencyKey),
        expire_by: Math.floor(params.expiresAt.getTime() / 1000),
        customer: { name: params.customerName, email: params.customerEmail },
        // Off deliberately — see the class comment. Our outbox and our policy
        // engine own customer communication.
        notify: { email: false, sms: false },
        reminder_enable: false,
        notes: { case_id: params.caseId, payment_id: params.paymentId, mode: "test" },
        ...(this.options.callbackUrl
          ? { callback_url: this.options.callbackUrl, callback_method: "get" }
          : {}),
      });

      return {
        success: true,
        linkId: link.id,
        url: link.short_url,
        provider: this.kind,
        raw: { status: link.status, referenceId: link.reference_id, amount: link.amount },
        error: null,
      };
    } catch (error) {
      // Recorded, never swallowed — the executor turns this into a FAILED action.
      return {
        success: false,
        linkId: null,
        url: null,
        provider: this.kind,
        raw: { error: describeRazorpayError(error) },
        error: describeRazorpayError(error),
      };
    }
  }

  async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    try {
      const payment = await this.client.payments.fetch(paymentId);
      return mapPaymentStatus(payment.status);
    } catch {
      // An unknown id is not a capture. Treat it as unresolved, never as success.
      return PaymentStatus.FAILED;
    }
  }

  async getPaymentLinkStatus(linkId: string): Promise<PaymentLinkStatus> {
    try {
      const link = await this.client.paymentLink.fetch(linkId);
      const paid = link.status === "paid";

      // amount_paid is authoritative; a partially paid link is not recovered.
      const paidInFull = paid && Number(link.amount_paid) >= Number(link.amount);

      return {
        paid: paidInFull,
        paidAt: paidInFull ? resolvePaidAt(link) : null,
        amountPaise: paidInFull ? Number(link.amount_paid) : null,
        externalReference: paidInFull ? (firstPaymentId(link) ?? link.id) : null,
      };
    } catch {
      return { paid: false, paidAt: null, amountPaise: null, externalReference: null };
    }
  }

  kindFor(action: RecoveryAction): ProviderKind {
    return action === RecoveryAction.RETRY_PAYMENT ? ProviderKind.SIMULATED : this.kind;
  }
}

function mapPaymentStatus(status: string): PaymentStatus {
  switch (status) {
    case "captured":
      return PaymentStatus.CAPTURED;
    case "authorized":
      return PaymentStatus.AUTHORIZED;
    case "refunded":
      return PaymentStatus.REFUNDED;
    case "created":
      return PaymentStatus.CREATED;
    default:
      return PaymentStatus.FAILED;
  }
}

/** Razorpay reports link payments in a `payments` array on the fetched link. */
type LinkWithPayments = { payments?: Array<{ payment_id?: string; created_at?: number }> };

function firstPaymentId(link: unknown): string | null {
  const payments = (link as LinkWithPayments).payments;
  return payments?.[0]?.payment_id ?? null;
}

function resolvePaidAt(link: unknown): Date {
  const createdAt = (link as LinkWithPayments).payments?.[0]?.created_at;
  return createdAt ? new Date(createdAt * 1000) : new Date();
}

/**
 * Razorpay caps `reference_id` at 40 characters, and our idempotency keys
 * (`<caseId>:<ACTION>:<cycle>`) run past that — a live 400 the simulator can
 * never reproduce. Hash anything too long instead of truncating, so two keys
 * sharing a 40-character prefix cannot collide into one link.
 */
export const RAZORPAY_REFERENCE_ID_MAX = 40;

export function toReferenceId(idempotencyKey: string): string {
  if (idempotencyKey.length <= RAZORPAY_REFERENCE_ID_MAX) return idempotencyKey;
  const digest = createHash("sha256").update(idempotencyKey).digest("hex");
  // "rcv_" + 32 hex = 36 characters, and still deterministic for the same key.
  return `rcv_${digest.slice(0, 32)}`;
}

function describeRazorpayError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { error?: { description?: string; code?: string }; message?: string };
    if (e.error?.description) return `${e.error.code ?? "razorpay_error"}: ${e.error.description}`;
    if (e.message) return e.message;
  }
  return String(error);
}

/** Kept exported so the webhook route can reuse the mapping when we add one. */
export { mapPaymentStatus, describeRazorpayError };