import type { Database } from "@/db/client";
import { newMessageId } from "@/core/domain/ids";
import { toIso, fromIso } from "@/core/clock";
import type { Row } from "@/db/repositories/mappers";

export interface OutboxMessage {
  id: string;
  caseId: string;
  customerId: string;
  actionId: string | null;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
  paymentLinkUrl: string | null;
  transport: string;
  sentAt: Date;
}

function toMessage(row: Row): OutboxMessage {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    customerId: String(row.customer_id),
    actionId: row.action_id === null || row.action_id === undefined ? null : String(row.action_id),
    channel: String(row.channel),
    recipient: String(row.recipient),
    subject: String(row.subject),
    body: String(row.body),
    paymentLinkUrl:
      row.payment_link_url === null || row.payment_link_url === undefined
        ? null
        : String(row.payment_link_url),
    transport: String(row.transport),
    sentAt: fromIso(String(row.sent_at)),
  };
}

/**
 * Outbound customer communication.
 *
 * `transport` records how a message actually left the system ("outbox" means
 * it was persisted and displayed, not delivered to an inbox), so the demo never
 * implies a real email was sent when it was not.
 */
export class OutboxRepository {
  constructor(private readonly db: Database) {}

  send(params: {
    caseId: string;
    customerId: string;
    actionId: string | null;
    channel: string;
    recipient: string;
    subject: string;
    body: string;
    paymentLinkUrl?: string | null;
    transport: string;
    at: Date;
  }): OutboxMessage {
    const id = newMessageId();
    this.db
      .prepare(
        `INSERT INTO outbox_messages
           (id, case_id, customer_id, action_id, channel, recipient, subject, body,
            payment_link_url, transport, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.caseId,
        params.customerId,
        params.actionId,
        params.channel,
        params.recipient,
        params.subject,
        params.body,
        params.paymentLinkUrl ?? null,
        params.transport,
        toIso(params.at),
      );
    const row = this.db.prepare(`SELECT * FROM outbox_messages WHERE id = ?`).get(id) as Row;
    return toMessage(row);
  }

  forCase(caseId: string): OutboxMessage[] {
    return (
      this.db
        .prepare(`SELECT * FROM outbox_messages WHERE case_id = ? ORDER BY sent_at ASC`)
        .all(caseId) as Row[]
    ).map(toMessage);
  }

  countForCustomer(customerId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM outbox_messages WHERE customer_id = ?`)
      .get(customerId) as { n: number };
    return Number(row.n);
  }
}
