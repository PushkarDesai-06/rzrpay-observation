import type { Database } from "@/db/client";
import type { Customer } from "@/core/domain/types";
import { toIso } from "@/core/clock";
import type { Paise } from "@/core/domain/money";
import { toCustomer, type Row } from "@/db/repositories/mappers";

export class CustomerRepository {
  constructor(private readonly db: Database) {}

  upsert(customer: {
    id: string;
    name: string;
    email: string;
    createdAt: Date;
    lifetimeValuePaise?: Paise;
    successfulPaymentsCount?: number;
    failedPaymentsCount?: number;
    lastSuccessfulPaymentAt?: Date | null;
  }): Customer {
    this.db
      .prepare(
        `INSERT INTO customers
           (id, name, email, created_at, lifetime_value_paise, successful_payments_count,
            failed_payments_count, last_successful_payment_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           email = excluded.email,
           lifetime_value_paise = excluded.lifetime_value_paise,
           successful_payments_count = excluded.successful_payments_count,
           failed_payments_count = excluded.failed_payments_count,
           last_successful_payment_at = excluded.last_successful_payment_at`,
      )
      .run(
        customer.id,
        customer.name,
        customer.email,
        toIso(customer.createdAt),
        customer.lifetimeValuePaise ?? 0,
        customer.successfulPaymentsCount ?? 0,
        customer.failedPaymentsCount ?? 0,
        customer.lastSuccessfulPaymentAt ? toIso(customer.lastSuccessfulPaymentAt) : null,
      );
    return this.require(customer.id);
  }

  find(id: string): Customer | null {
    const row = this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id) as Row | undefined;
    return row ? toCustomer(row) : null;
  }

  require(id: string): Customer {
    const found = this.find(id);
    if (!found) throw new Error(`Customer not found: ${id}`);
    return found;
  }

  recordFailedPayment(id: string): void {
    this.db
      .prepare(`UPDATE customers SET failed_payments_count = failed_payments_count + 1 WHERE id = ?`)
      .run(id);
  }

  recordSuccessfulPayment(id: string, amountPaise: Paise, at: Date): void {
    this.db
      .prepare(
        `UPDATE customers
            SET successful_payments_count = successful_payments_count + 1,
                lifetime_value_paise = lifetime_value_paise + ?,
                last_successful_payment_at = ?
          WHERE id = ?`,
      )
      .run(amountPaise, toIso(at), id);
  }
}
