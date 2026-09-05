import type { Database } from "@/db/client";
import type { RecoveryCase } from "@/core/domain/types";
import { RecoveryAction } from "@/core/domain/enums";
import type { RecoveryContext, PriorAction } from "@/core/context/recovery-context";
import { buildRecoveryContext } from "@/core/context/recovery-context";
import type { RecoveryPolicy } from "@/core/policy/policy-config";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import { CustomerRepository } from "@/db/repositories/customer-repository";
import { PaymentRepository } from "@/db/repositories/payment-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { toIso } from "@/core/clock";

/**
 * Reads the case's world out of the database and hands it to the pure builder.
 * The only component that fetches context; the agent never queries anything.
 */
export class ContextBuilder {
  private readonly customers: CustomerRepository;
  private readonly payments: PaymentRepository;
  private readonly actions: ActionRepository;

  constructor(
    db: Database,
    private readonly policy: RecoveryPolicy = DEFAULT_POLICY,
  ) {
    this.customers = new CustomerRepository(db);
    this.payments = new PaymentRepository(db);
    this.actions = new ActionRepository(db);
  }

  build(recoveryCase: RecoveryCase, now: Date): RecoveryContext {
    const payment = this.payments.require(recoveryCase.paymentId);
    const customer = this.customers.require(recoveryCase.customerId);

    const priorActions: PriorAction[] = this.actions.forCase(recoveryCase.id).map((a) => ({
      action: a.action,
      at: toIso(a.createdAt),
      status: a.status,
      outcome: typeof a.result?.outcome === "string" ? a.result.outcome : null,
    }));

    return buildRecoveryContext({
      recoveryCase,
      payment,
      customer,
      cycle: recoveryCase.cycleCount,
      retriesAttempted: this.actions.countAttempted(recoveryCase.id, RecoveryAction.RETRY_PAYMENT),
      remindersSent: this.actions.countSucceeded(recoveryCase.id, RecoveryAction.SEND_REMINDER),
      paymentLinksCreated: this.actions.countSucceeded(recoveryCase.id, RecoveryAction.CREATE_PAYMENT_LINK),
      lastCustomerContactAt: this.actions.lastCustomerContact(recoveryCase.id)?.createdAt ?? null,
      lastRetryAt: this.actions.lastOf(recoveryCase.id, RecoveryAction.RETRY_PAYMENT)?.createdAt ?? null,
      priorActions,
      policy: this.policy,
      now,
    });
  }
}
