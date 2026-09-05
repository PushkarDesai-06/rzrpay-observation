import type { Database } from "@/db/client";
import type { PaymentEvent } from "@/core/domain/types";
import type { EventType } from "@/core/domain/enums";
import { newEventId } from "@/core/domain/ids";
import { toIso } from "@/core/clock";
import { toPaymentEvent, type Row } from "@/db/repositories/mappers";

export class EventRepository {
  constructor(private readonly db: Database) {}

  /**
   * Store an inbound event.
   *
   * Returns `duplicate: true` without writing anything if this exact event has
   * already been seen. Idempotency is decided by the UNIQUE index, not by a
   * prior SELECT, so a redelivered webhook is safe even under concurrency.
   */
  record(event: {
    idempotencyKey: string;
    type: EventType;
    paymentId: string | null;
    customerId: string | null;
    payload: Record<string, unknown>;
    receivedAt: Date;
  }): { event: PaymentEvent; duplicate: boolean } {
    const existing = this.findByIdempotencyKey(event.idempotencyKey);
    if (existing) return { event: existing, duplicate: true };

    const id = newEventId();
    try {
      this.db
        .prepare(
          `INSERT INTO payment_events
             (id, idempotency_key, type, payment_id, customer_id, payload_json, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          event.idempotencyKey,
          event.type,
          event.paymentId,
          event.customerId,
          JSON.stringify(event.payload),
          toIso(event.receivedAt),
        );
    } catch (error) {
      // Lost a race against a concurrent delivery of the same event.
      const raced = this.findByIdempotencyKey(event.idempotencyKey);
      if (raced) return { event: raced, duplicate: true };
      throw error;
    }
    return { event: this.require(id), duplicate: false };
  }

  markProcessed(eventId: string, caseId: string | null, at: Date): void {
    this.db
      .prepare(`UPDATE payment_events SET processed_at = ?, case_id = ? WHERE id = ?`)
      .run(toIso(at), caseId, eventId);
  }

  findByIdempotencyKey(key: string): PaymentEvent | null {
    const row = this.db
      .prepare(`SELECT * FROM payment_events WHERE idempotency_key = ?`)
      .get(key) as Row | undefined;
    return row ? toPaymentEvent(row) : null;
  }

  require(id: string): PaymentEvent {
    const row = this.db.prepare(`SELECT * FROM payment_events WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new Error(`Event not found: ${id}`);
    return toPaymentEvent(row);
  }

  forCase(caseId: string): PaymentEvent[] {
    return (
      this.db
        .prepare(`SELECT * FROM payment_events WHERE case_id = ? ORDER BY received_at ASC`)
        .all(caseId) as Row[]
    ).map(toPaymentEvent);
  }
}
