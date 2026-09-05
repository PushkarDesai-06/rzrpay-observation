import type { Database } from "@/db/client";
import type { Payment } from "@/core/domain/types";
import type { FailureCode, PaymentMethod, PaymentStatus, ProviderKind } from "@/core/domain/enums";
import { toIso } from "@/core/clock";
import type { Paise } from "@/core/domain/money";
import { toPayment, type Row } from "@/db/repositories/mappers";

export class PaymentRepository {
  constructor(private readonly db: Database) {}

  upsert(payment: {
    id: string;
    customerId: string;
    amountPaise: Paise;
    currency?: string;
    status: PaymentStatus;
    method: PaymentMethod;
    failureCode?: FailureCode | null;
    failureReasonRaw?: string | null;
    attemptNumber?: number;
    provider: ProviderKind;
    at: Date;
  }): Payment {
    const now = toIso(payment.at);
    this.db
      .prepare(
        `INSERT INTO payments
           (id, customer_id, amount_paise, currency, status, method, failure_code,
            failure_reason_raw, attempt_number, provider, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           failure_code = excluded.failure_code,
           failure_reason_raw = excluded.failure_reason_raw,
           attempt_number = excluded.attempt_number,
           updated_at = excluded.updated_at`,
      )
      .run(
        payment.id,
        payment.customerId,
        payment.amountPaise,
        payment.currency ?? "INR",
        payment.status,
        payment.method,
        payment.failureCode ?? null,
        payment.failureReasonRaw ?? null,
        payment.attemptNumber ?? 1,
        payment.provider,
        now,
        now,
      );
    return this.require(payment.id);
  }

  find(id: string): Payment | null {
    const row = this.db.prepare(`SELECT * FROM payments WHERE id = ?`).get(id) as Row | undefined;
    return row ? toPayment(row) : null;
  }

  require(id: string): Payment {
    const found = this.find(id);
    if (!found) throw new Error(`Payment not found: ${id}`);
    return found;
  }

  updateStatus(id: string, status: PaymentStatus, at: Date): void {
    this.db
      .prepare(`UPDATE payments SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, toIso(at), id);
  }

  /** Prior payments for a customer, excluding the one under recovery. */
  historyForCustomer(customerId: string, excludePaymentId?: string): Payment[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM payments WHERE customer_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 50`,
      )
      .all(customerId, excludePaymentId ?? "") as Row[];
    return rows.map(toPayment);
  }
}
