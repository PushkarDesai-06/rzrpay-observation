import type { Database } from "@/db/client";
import type { Clock } from "@/core/clock";
import { OutboxRepository } from "@/db/repositories/outbox-repository";
import { formatINR, type Paise } from "@/core/domain/money";

export interface OutboundMessage {
  caseId: string;
  customerId: string;
  actionId: string | null;
  recipient: string;
  customerName: string;
  amountPaise: Paise;
  paymentLinkUrl: string | null;
  kind: "payment_link" | "reminder";
}

export interface NotifyResult {
  delivered: boolean;
  reference: string | null;
  error: string | null;
  transport: string;
}

export interface Notifier {
  readonly transport: string;
  send(message: OutboundMessage): Promise<NotifyResult>;
}

export function composeMessage(message: OutboundMessage): { subject: string; body: string } {
  const amount = formatINR(message.amountPaise);
  if (message.kind === "payment_link") {
    return {
      subject: `Your ${amount} payment didn't go through`,
      body: `Hi ${message.customerName},\n\nWe weren't able to process your ${amount} payment. You can complete it here:\n\n${message.paymentLinkUrl}\n\nIf you've already paid, please ignore this message.`,
    };
  }
  return {
    subject: `Reminder: ${amount} payment still pending`,
    body: `Hi ${message.customerName},\n\nYour ${amount} payment is still outstanding. You can complete it here:\n\n${message.paymentLinkUrl ?? "(link unavailable)"}\n\nThis is our last reminder about this payment.`,
  };
}

/**
 * Persists outbound messages instead of delivering them.
 *
 * `transport: "outbox"` is recorded on every row and shown in the UI, so a
 * message that was stored and displayed is never presented as one that reached
 * a real inbox. The communication limits are enforced identically either way,
 * which is the part worth demonstrating.
 */
export class OutboxNotifier implements Notifier {
  readonly transport = "outbox";
  private readonly outbox: OutboxRepository;

  constructor(
    db: Database,
    private readonly clock: Clock,
  ) {
    this.outbox = new OutboxRepository(db);
  }

  send(message: OutboundMessage): Promise<NotifyResult> {
    const { subject, body } = composeMessage(message);
    const stored = this.outbox.send({
      caseId: message.caseId,
      customerId: message.customerId,
      actionId: message.actionId,
      channel: "email",
      recipient: message.recipient,
      subject,
      body,
      paymentLinkUrl: message.paymentLinkUrl,
      transport: this.transport,
      at: this.clock.now(),
    });
    return Promise.resolve({
      delivered: true,
      reference: stored.id,
      error: null,
      transport: this.transport,
    });
  }
}
