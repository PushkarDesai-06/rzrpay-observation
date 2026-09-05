import { FailureCode, PaymentStatus, ProviderKind } from "@/core/domain/enums";
import type { Clock } from "@/core/clock";
import type { Paise } from "@/core/domain/money";
import { chance, draw, drawInt } from "@/providers/rng";
import type {
  PaymentLinkResult,
  PaymentLinkStatus,
  PaymentProvider,
  PaymentResult,
} from "@/providers/payment-provider";

/**
 * Probability that retrying the SAME instrument succeeds, by failure cause.
 *
 * These are committed here, in one table, precisely so the simulation cannot be
 * quietly tuned to flatter the agent. The shape reflects how payment failures
 * actually behave: transient issuer and network faults clear on their own, while
 * an expired card or a wrong CVV is a fact about the instrument that a retry
 * cannot change. Any dataset produced with these numbers is SYNTHETIC and is
 * labelled as such wherever it is reported.
 */
export const RETRY_SUCCESS_RATE: Readonly<Record<FailureCode, number>> = Object.freeze({
  [FailureCode.ISSUER_UNAVAILABLE]: 0.7,
  [FailureCode.GATEWAY_TIMEOUT]: 0.65,
  [FailureCode.NETWORK_ERROR]: 0.62,
  [FailureCode.LIMIT_EXCEEDED]: 0.2,
  [FailureCode.INSUFFICIENT_FUNDS]: 0.15,
  [FailureCode.CARD_DECLINED]: 0.12,
  [FailureCode.AUTHENTICATION_FAILED]: 0.1,
  [FailureCode.PAYMENT_CANCELLED]: 0.05,
  [FailureCode.INCORRECT_CVV]: 0.03,
  [FailureCode.CARD_EXPIRED]: 0.02,
  [FailureCode.UNKNOWN]: 0.25,
});

/**
 * Probability that a customer eventually completes a payment link.
 *
 * Higher than retry for exactly the failures where the customer can fix the
 * problem themselves — a new card, a correct CVV, a completed 3DS challenge.
 * This is the modelled reason choosing the right intervention matters, and it
 * is why a system that always retries leaves money on the table.
 */
export const LINK_CONVERSION_RATE: Readonly<Record<FailureCode, number>> = Object.freeze({
  [FailureCode.INCORRECT_CVV]: 0.6,
  [FailureCode.CARD_EXPIRED]: 0.55,
  [FailureCode.AUTHENTICATION_FAILED]: 0.5,
  [FailureCode.ISSUER_UNAVAILABLE]: 0.5,
  [FailureCode.GATEWAY_TIMEOUT]: 0.5,
  [FailureCode.NETWORK_ERROR]: 0.5,
  [FailureCode.CARD_DECLINED]: 0.45,
  [FailureCode.LIMIT_EXCEEDED]: 0.4,
  [FailureCode.INSUFFICIENT_FUNDS]: 0.35,
  [FailureCode.UNKNOWN]: 0.35,
  [FailureCode.PAYMENT_CANCELLED]: 0.25,
});

/**
 * How much the success rate decays on each successive retry of the same payment.
 *
 * Drawing every retry independently from the table above is wrong and badly
 * flattering: three independent draws at 0.70 compound to a 97% recovery rate,
 * which no real payment book achieves. A retry that already failed is evidence
 * the failure was not transient after all, so later attempts must be worth
 * progressively less. With this decay, three retries of a transient issuer
 * failure reach roughly 79% rather than 97%.
 */
const RETRY_ATTEMPT_DECAY = 0.4;

/** A reminder gives one extra, weaker draw on an unpaid link. */
const REMINDER_RECOVERY_RATE = 0.25;

/** Simulated provider-side failures, so the executor's error path is exercised. */
const API_FAILURE_RATE = 0.04;

interface SimulatedLink {
  linkId: string;
  caseId: string;
  amountPaise: Paise;
  createdAt: Date;
  /** Null when the simulated customer never pays. */
  payAt: Date | null;
  remindersApplied: number;
}

export interface SimulatedProviderOptions {
  seed: number;
  clock: Clock;
  /** Set false in tests that must never see a simulated API outage. */
  simulateApiFailures?: boolean;
}

/**
 * A payment provider that models outcomes instead of calling one.
 *
 * Every outcome is a deterministic function of (seed, key), so an entire batch
 * replays identically and the agent and the baseline face the same draws.
 */
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly kind = ProviderKind.SIMULATED;

  private readonly seed: number;
  private readonly clock: Clock;
  private readonly simulateApiFailures: boolean;
  private readonly links = new Map<string, SimulatedLink>();
  private readonly payments = new Map<string, { status: PaymentStatus; failureCode: FailureCode }>();

  /**
   * Per-payment call ordinals.
   *
   * Draw keys are built from (paymentId, ordinal) rather than from an action's
   * idempotency key, because that key embeds a randomly generated case id.
   * Keying on it would make every run draw differently and quietly destroy the
   * reproducibility the baseline comparison depends on.
   */
  private readonly retryOrdinal = new Map<string, number>();
  private readonly linkOrdinal = new Map<string, number>();

  private nextOrdinal(map: Map<string, number>, paymentId: string): number {
    const next = (map.get(paymentId) ?? 0) + 1;
    map.set(paymentId, next);
    return next;
  }

  constructor(options: SimulatedProviderOptions) {
    this.seed = options.seed;
    this.clock = options.clock;
    this.simulateApiFailures = options.simulateApiFailures ?? true;
  }

  /** Seed the provider with the failure that opened a case. */
  registerFailedPayment(paymentId: string, failureCode: FailureCode): void {
    this.payments.set(paymentId, { status: PaymentStatus.FAILED, failureCode });
  }

  retryPayment(params: {
    paymentId: string;
    amountPaise: Paise;
    currency: string;
    idempotencyKey: string;
  }): Promise<PaymentResult> {
    const known = this.payments.get(params.paymentId);
    const failureCode = known?.failureCode ?? FailureCode.UNKNOWN;
    const attempt = this.nextOrdinal(this.retryOrdinal, params.paymentId);
    const key = `${params.paymentId}:retry:${attempt}`;

    if (this.simulateApiFailures && chance(this.seed, `api:${key}`, API_FAILURE_RATE)) {
      return Promise.reject(new Error("Simulated provider error: upstream gateway returned 502"));
    }

    const probability =
      RETRY_SUCCESS_RATE[failureCode] * Math.pow(RETRY_ATTEMPT_DECAY, attempt - 1);
    const succeeded = chance(this.seed, key, probability);

    if (succeeded) {
      this.payments.set(params.paymentId, { status: PaymentStatus.CAPTURED, failureCode });
      return Promise.resolve({
        success: true,
        status: PaymentStatus.CAPTURED,
        externalReference: `sim_pay_${params.paymentId}`,
        failureCode: null,
        failureReasonRaw: null,
        provider: this.kind,
        raw: { simulated: true, outcome: "captured", amountPaise: params.amountPaise },
      });
    }

    return Promise.resolve({
      success: false,
      status: PaymentStatus.FAILED,
      externalReference: null,
      failureCode,
      failureReasonRaw: `Retry failed: ${failureCode}`,
      provider: this.kind,
      raw: { simulated: true, outcome: "failed", failureCode },
    });
  }

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
  }): Promise<PaymentLinkResult> {
    const ordinal = this.nextOrdinal(this.linkOrdinal, params.paymentId);
    const linkId = `sim_link_${params.paymentId}_${ordinal}`;

    if (this.simulateApiFailures && chance(this.seed, `api:${linkId}`, API_FAILURE_RATE)) {
      return Promise.resolve({
        success: false,
        linkId: null,
        url: null,
        provider: this.kind,
        raw: { simulated: true },
        error: "Simulated provider error: link creation timed out",
      });
    }

    const failureCode = this.payments.get(params.paymentId)?.failureCode ?? FailureCode.UNKNOWN;
    const now = this.clock.now();

    // Decide up front whether this customer ever pays, and when. Fixing it at
    // creation keeps the outcome independent of how often we poll for it.
    const willPay = chance(this.seed, `link:${linkId}`, LINK_CONVERSION_RATE[failureCode]);
    const delayHours = drawInt(this.seed, `linkdelay:${linkId}`, 1, 40);
    const payAt = willPay ? new Date(now.getTime() + delayHours * 3_600_000) : null;

    this.links.set(linkId, {
      linkId,
      caseId: params.caseId,
      amountPaise: params.amountPaise,
      createdAt: now,
      payAt,
      remindersApplied: 0,
    });

    return Promise.resolve({
      success: true,
      linkId,
      url: `https://pay.simulated.test/l/${linkId}`,
      provider: this.kind,
      raw: { simulated: true, expiresAt: params.expiresAt.toISOString() },
      error: null,
    });
  }

  /**
   * A reminder gets one weaker extra draw on a link the customer was not
   * otherwise going to pay. Bounded, so nagging cannot manufacture revenue.
   */
  notePaymentLinkReminder(linkId: string): void {
    const link = this.links.get(linkId);
    if (!link || link.payAt !== null) return;

    link.remindersApplied += 1;
    const key = `reminder:${linkId}:${link.remindersApplied}`;
    if (chance(this.seed, key, REMINDER_RECOVERY_RATE)) {
      const delayHours = drawInt(this.seed, `reminderdelay:${key}`, 1, 12);
      link.payAt = new Date(this.clock.now().getTime() + delayHours * 3_600_000);
    }
  }

  getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    return Promise.resolve(this.payments.get(paymentId)?.status ?? PaymentStatus.FAILED);
  }

  getPaymentLinkStatus(linkId: string): Promise<PaymentLinkStatus> {
    const link = this.links.get(linkId);
    if (!link) {
      return Promise.resolve({ paid: false, paidAt: null, amountPaise: null, externalReference: null });
    }
    const paid = link.payAt !== null && this.clock.now().getTime() >= link.payAt.getTime();
    return Promise.resolve({
      paid,
      paidAt: paid ? link.payAt : null,
      amountPaise: paid ? link.amountPaise : null,
      externalReference: paid ? `sim_pay_link_${linkId}` : null,
    });
  }

  /** Exposed for the evaluation harness to report the modelled odds. */
  odds(failureCode: FailureCode, attempt = 1): { retry: number; link: number } {
    return {
      retry: RETRY_SUCCESS_RATE[failureCode] * Math.pow(RETRY_ATTEMPT_DECAY, attempt - 1),
      link: LINK_CONVERSION_RATE[failureCode],
    };
  }

  /** Deterministic per-key draw, used by the seeder for scenario variation. */
  static drawFor(seed: number, key: string): number {
    return draw(seed, key);
  }
}
