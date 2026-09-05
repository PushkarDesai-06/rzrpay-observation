import type {
  AuditEntry,
  Customer,
  Payment,
  PaymentEvent,
  RecoveryCase,
  StateTransition,
} from "@/core/domain/types";
import type {
  Diagnosis,
  EventType,
  FailureCode,
  PaymentMethod,
  PaymentStatus,
  ProviderKind,
  Recoverability,
  RecoveryState,
} from "@/core/domain/enums";
import { fromIso } from "@/core/clock";

export type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const num = (v: unknown): number => Number(v);
const nullableStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const nullableNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const date = (v: unknown): Date => fromIso(String(v));
const nullableDate = (v: unknown): Date | null =>
  v === null || v === undefined ? null : fromIso(String(v));

export function toCustomer(row: Row): Customer {
  return {
    id: str(row.id),
    name: str(row.name),
    email: str(row.email),
    createdAt: date(row.created_at),
    lifetimeValuePaise: num(row.lifetime_value_paise),
    successfulPaymentsCount: num(row.successful_payments_count),
    failedPaymentsCount: num(row.failed_payments_count),
    lastSuccessfulPaymentAt: nullableDate(row.last_successful_payment_at),
  };
}

export function toPayment(row: Row): Payment {
  return {
    id: str(row.id),
    customerId: str(row.customer_id),
    amountPaise: num(row.amount_paise),
    currency: str(row.currency),
    status: str(row.status) as PaymentStatus,
    method: str(row.method) as PaymentMethod,
    failureCode: nullableStr(row.failure_code) as FailureCode | null,
    failureReasonRaw: nullableStr(row.failure_reason_raw),
    attemptNumber: num(row.attempt_number),
    provider: str(row.provider) as ProviderKind,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export function toPaymentEvent(row: Row): PaymentEvent {
  return {
    id: str(row.id),
    idempotencyKey: str(row.idempotency_key),
    type: str(row.type) as EventType,
    paymentId: nullableStr(row.payment_id),
    customerId: nullableStr(row.customer_id),
    payload: JSON.parse(str(row.payload_json)) as Record<string, unknown>,
    receivedAt: date(row.received_at),
    processedAt: nullableDate(row.processed_at),
    caseId: nullableStr(row.case_id),
  };
}

export function toRecoveryCase(row: Row): RecoveryCase {
  return {
    id: str(row.id),
    paymentId: str(row.payment_id),
    customerId: str(row.customer_id),
    amountPaise: num(row.amount_paise),
    currency: str(row.currency),
    state: str(row.state) as RecoveryState,
    diagnosis: nullableStr(row.diagnosis) as Diagnosis | null,
    recoverability: nullableStr(row.recoverability) as Recoverability | null,
    confidence: nullableNum(row.confidence),
    cycleCount: num(row.cycle_count),
    openedAt: date(row.opened_at),
    updatedAt: date(row.updated_at),
    nextEvaluationAt: nullableDate(row.next_evaluation_at),
    closedAt: nullableDate(row.closed_at),
    recoveredAt: nullableDate(row.recovered_at),
    recoveredAmountPaise: nullableNum(row.recovered_amount_paise),
  };
}

export function toStateTransition(row: Row): StateTransition {
  return {
    id: str(row.id),
    caseId: str(row.case_id),
    fromState: str(row.from_state) as RecoveryState,
    toState: str(row.to_state) as RecoveryState,
    trigger: str(row.trigger),
    detail: nullableStr(row.detail),
    at: date(row.at),
  };
}

export function toAuditEntry(row: Row): AuditEntry {
  return {
    id: str(row.id),
    at: date(row.at),
    caseId: nullableStr(row.case_id),
    event: str(row.event),
    actor: str(row.actor),
    detail: JSON.parse(str(row.detail_json)) as Record<string, unknown>,
  };
}
