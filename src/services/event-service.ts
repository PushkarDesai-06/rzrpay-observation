import type { Database } from "@/db/client";
import type { Clock } from "@/core/clock";
import type { RecoveryCase } from "@/core/domain/types";
import {
  EventType,
  PaymentStatus,
  RecoveryState,
  type PaymentMethod,
  type ProviderKind,
} from "@/core/domain/enums";
import { normaliseFailureReason } from "@/core/domain/failure-codes";
import { eventIdempotencyKey } from "@/core/domain/ids";
import type { Paise } from "@/core/domain/money";
import { CaseRepository } from "@/db/repositories/case-repository";
import { CustomerRepository } from "@/db/repositories/customer-repository";
import { PaymentRepository } from "@/db/repositories/payment-repository";
import { EventRepository } from "@/db/repositories/event-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";

export interface PaymentFailedEvent {
  provider: ProviderKind;
  paymentId: string;
  customer: { id: string; name: string; email: string };
  amountPaise: Paise;
  currency?: string;
  method: PaymentMethod;
  failureReasonRaw: string | null;
  attemptNumber?: number;
  occurredAt?: Date;
  /** Supply to override the derived key, e.g. a provider's own event id. */
  idempotencyKey?: string;
}

export interface IngestResult {
  case: RecoveryCase;
  /** False when this event had already been seen; nothing was re-processed. */
  accepted: boolean;
  /** False when the case already existed for this payment. */
  caseCreated: boolean;
  reason: string;
}

/**
 * Detection layer.
 *
 * Deterministic throughout: `payment.status === failed` is enough to open a
 * case, so no model is consulted here. Its one hard guarantee is that N
 * deliveries of the same failure produce exactly one recovery case and one
 * unit of revenue at risk.
 */
export class EventService {
  private readonly cases: CaseRepository;
  private readonly customers: CustomerRepository;
  private readonly payments: PaymentRepository;
  private readonly events: EventRepository;
  private readonly audit: AuditRepository;

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {
    this.cases = new CaseRepository(db);
    this.customers = new CustomerRepository(db);
    this.payments = new PaymentRepository(db);
    this.events = new EventRepository(db);
    this.audit = new AuditRepository(db);
  }

  ingestPaymentFailed(input: PaymentFailedEvent): IngestResult {
    const at = input.occurredAt ?? this.clock.now();
    const key =
      input.idempotencyKey ??
      eventIdempotencyKey(input.provider, input.paymentId, EventType.PAYMENT_FAILED);

    const failureCode = normaliseFailureReason(input.failureReasonRaw);

    const { event, duplicate } = this.events.record({
      idempotencyKey: key,
      type: EventType.PAYMENT_FAILED,
      paymentId: input.paymentId,
      customerId: input.customer.id,
      payload: { ...input, failureCode, occurredAt: at.toISOString() },
      receivedAt: at,
    });

    if (duplicate) {
      const existing = this.cases.findByPaymentId(input.paymentId);
      if (!existing) {
        // Event seen before but no case: the earlier attempt failed midway.
        // Fall through and open the case rather than silently dropping it.
      } else {
        this.audit.append({
          at,
          caseId: existing.id,
          event: "DUPLICATE_EVENT_IGNORED",
          actor: "detection",
          detail: { idempotencyKey: key, paymentId: input.paymentId },
        });
        return {
          case: existing,
          accepted: false,
          caseCreated: false,
          reason: "Duplicate event; existing recovery case left untouched",
        };
      }
    }

    // Upsert must not clobber the payment history the agent reasons over, so
    // an existing customer's counters are carried forward untouched.
    const known = this.customers.find(input.customer.id);
    this.customers.upsert({
      id: input.customer.id,
      name: input.customer.name,
      email: input.customer.email,
      createdAt: known?.createdAt ?? at,
      lifetimeValuePaise: known?.lifetimeValuePaise ?? 0,
      successfulPaymentsCount: known?.successfulPaymentsCount ?? 0,
      failedPaymentsCount: known?.failedPaymentsCount ?? 0,
      lastSuccessfulPaymentAt: known?.lastSuccessfulPaymentAt ?? null,
    });

    this.payments.upsert({
      id: input.paymentId,
      customerId: input.customer.id,
      amountPaise: input.amountPaise,
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      status: PaymentStatus.FAILED,
      method: input.method,
      failureCode,
      failureReasonRaw: input.failureReasonRaw,
      ...(input.attemptNumber !== undefined ? { attemptNumber: input.attemptNumber } : {}),
      provider: input.provider,
      at,
    });

    const { case: recoveryCase, created } = this.cases.createOrGet({
      paymentId: input.paymentId,
      customerId: input.customer.id,
      amountPaise: input.amountPaise,
      currency: input.currency ?? "INR",
      at,
    });

    if (created) {
      this.customers.recordFailedPayment(input.customer.id);
      // Open cases are picked up by the next scheduler tick.
      this.cases.scheduleNextEvaluation(recoveryCase.id, at);
    }

    this.events.markProcessed(event.id, recoveryCase.id, at);

    return {
      case: this.cases.requireById(recoveryCase.id),
      accepted: true,
      caseCreated: created,
      reason: created
        ? "Recovery case opened"
        : "Recovery case already existed for this payment",
    };
  }

  /** Revenue currently inside active (non-terminal) recovery workflows. */
  revenueAtRiskPaise(): Paise {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_paise), 0) AS total
           FROM recovery_cases
          WHERE state NOT IN ('RECOVERED','FAILED','NOT_RECOVERABLE','ESCALATED','STOPPED')`,
      )
      .get() as { total: number };
    return row.total;
  }

  openStates(): RecoveryState[] {
    return Object.values(RecoveryState).filter(
      (s) => !["RECOVERED", "FAILED", "NOT_RECOVERABLE", "ESCALATED", "STOPPED"].includes(s),
    );
  }
}
