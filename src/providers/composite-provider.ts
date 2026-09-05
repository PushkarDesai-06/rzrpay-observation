import { ProviderKind, RecoveryAction } from "@/core/domain/enums";
import type { PaymentStatus } from "@/core/domain/enums";
import type {
  PaymentLinkResult,
  PaymentLinkStatus,
  PaymentProvider,
  PaymentResult,
} from "@/providers/payment-provider";

/**
 * Routes each capability to whichever backend can honestly perform it.
 *
 * This exists because of one real constraint, not for flexibility's sake:
 * Razorpay can create and observe payment links in test mode, but it cannot
 * re-charge a failed payment server-side. Rather than fake a retry against the
 * live API, retries go to the simulator and every action records which backend
 * ran it, so the split is visible in the audit trail and the interface.
 *
 * The alternative — quietly reporting a simulated retry as a Razorpay one —
 * would make the demo's most important number untrustworthy.
 */
export class CompositePaymentProvider implements PaymentProvider {
  /** Reported for the integration as a whole; per-action truth is in kindFor. */
  readonly kind: ProviderKind;

  constructor(
    private readonly retryBackend: PaymentProvider,
    private readonly linkBackend: PaymentProvider,
  ) {
    this.kind = linkBackend.kind;
  }

  kindFor(action: RecoveryAction): ProviderKind {
    return action === RecoveryAction.RETRY_PAYMENT ? this.retryBackend.kind : this.linkBackend.kind;
  }

  retryPayment(params: Parameters<PaymentProvider["retryPayment"]>[0]): Promise<PaymentResult> {
    return this.retryBackend.retryPayment(params);
  }

  createRecoveryLink(
    params: Parameters<PaymentProvider["createRecoveryLink"]>[0],
  ): Promise<PaymentLinkResult> {
    return this.linkBackend.createRecoveryLink(params);
  }

  /**
   * Payment status is asked of whoever handled the retry, because that is the
   * backend that knows whether the original instrument was ever charged.
   */
  getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    return this.retryBackend.getPaymentStatus(paymentId);
  }

  getPaymentLinkStatus(linkId: string): Promise<PaymentLinkStatus> {
    return this.linkBackend.getPaymentLinkStatus(linkId);
  }

  notePaymentLinkReminder(linkId: string): void {
    this.linkBackend.notePaymentLinkReminder?.(linkId);
  }

  /** Human-readable provenance for the demo header and the dashboard. */
  describe(): string {
    return `retries: ${this.retryBackend.kind} · links: ${this.linkBackend.kind}`;
  }
}
