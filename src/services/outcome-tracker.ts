import type { Database } from "@/db/client";
import type { Clock } from "@/core/clock";
import { hoursBetween } from "@/core/clock";
import {
  ActionStatus,
  PaymentStatus,
  RecoveryAction,
  RecoveryState,
} from "@/core/domain/enums";
import type { RecoveryCase } from "@/core/domain/types";
import type { RecoveryPolicy } from "@/core/policy/policy-config";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import { CaseRepository } from "@/db/repositories/case-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { CustomerRepository } from "@/db/repositories/customer-repository";
import { PaymentRepository } from "@/db/repositories/payment-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";
import type { PaymentProvider } from "@/providers/payment-provider";

export interface ObservationResult {
  caseId: string;
  state: RecoveryState;
  recovered: boolean;
  recoveredAmountPaise: number | null;
  detail: string;
}

/**
 * Observes what actually happened after an intervention.
 *
 * This is the only component in the system that may mark revenue recovered, and
 * it will not do so on the strength of our own optimism: even when a retry call
 * returned success, the payment status is re-read from the provider before the
 * case is closed. An attempt is not revenue; a confirmed capture is.
 */
export class OutcomeTracker {
  private readonly cases: CaseRepository;
  private readonly actions: ActionRepository;
  private readonly customers: CustomerRepository;
  private readonly payments: PaymentRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly provider: PaymentProvider,
    private readonly clock: Clock,
    private readonly policy: RecoveryPolicy = DEFAULT_POLICY,
  ) {
    this.cases = new CaseRepository(db);
    this.actions = new ActionRepository(db);
    this.customers = new CustomerRepository(db);
    this.payments = new PaymentRepository(db);
    this.audit = new AuditRepository(db);
  }

  async observe(recoveryCase: RecoveryCase): Promise<ObservationResult> {
    if (recoveryCase.state !== RecoveryState.WAITING_FOR_OUTCOME) {
      return {
        caseId: recoveryCase.id,
        state: recoveryCase.state,
        recovered: false,
        recoveredAmountPaise: null,
        detail: `Not awaiting an outcome (state ${recoveryCase.state})`,
      };
    }

    const now = this.clock.now();
    const confirmed = await this.confirmPayment(recoveryCase);

    if (confirmed) {
      return this.markRecovered(recoveryCase, confirmed.reference, confirmed.via);
    }

    // Nothing recovered yet. Either the window has closed, or we try again.
    const hoursOpen = hoursBetween(recoveryCase.openedAt, now);
    if (hoursOpen >= this.policy.maximumRecoveryDurationHours) {
      const stopped = this.cases.transitionState({
        caseId: recoveryCase.id,
        to: RecoveryState.STOPPED,
        trigger: "recovery_window_expired",
        at: now,
        detail: `No confirmed payment after ${hoursOpen.toFixed(1)}h`,
        actor: "outcome_tracker",
      });
      return {
        caseId: recoveryCase.id,
        state: stopped.state,
        recovered: false,
        recoveredAmountPaise: null,
        detail: "Recovery window expired without a confirmed payment",
      };
    }

    const reopened = this.cases.transitionState({
      caseId: recoveryCase.id,
      to: RecoveryState.ANALYZING,
      trigger: "outcome_pending_reevaluate",
      at: now,
      detail: "No confirmed payment yet; re-evaluating",
      actor: "outcome_tracker",
    });
    return {
      caseId: recoveryCase.id,
      state: reopened.state,
      recovered: false,
      recoveredAmountPaise: null,
      detail: "No payment confirmed yet; case returned for re-evaluation",
    };
  }

  /**
   * Ask the provider — not our own records — whether money actually arrived.
   */
  private async confirmPayment(
    recoveryCase: RecoveryCase,
  ): Promise<{ reference: string; via: RecoveryAction } | null> {
    const actions = this.actions.forCase(recoveryCase.id);

    const succeededRetry = actions.find(
      (a) => a.action === RecoveryAction.RETRY_PAYMENT && a.status === ActionStatus.SUCCEEDED,
    );
    if (succeededRetry) {
      const status = await this.provider.getPaymentStatus(recoveryCase.paymentId);
      if (status === PaymentStatus.CAPTURED) {
        return {
          reference: succeededRetry.externalRef ?? recoveryCase.paymentId,
          via: RecoveryAction.RETRY_PAYMENT,
        };
      }
    }

    const link = actions.find(
      (a) =>
        a.action === RecoveryAction.CREATE_PAYMENT_LINK &&
        a.status === ActionStatus.SUCCEEDED &&
        a.externalRef,
    );
    if (link?.externalRef) {
      const linkStatus = await this.provider.getPaymentLinkStatus(link.externalRef);
      if (linkStatus.paid) {
        return {
          reference: linkStatus.externalReference ?? link.externalRef,
          via: RecoveryAction.CREATE_PAYMENT_LINK,
        };
      }
    }

    return null;
  }

  private markRecovered(
    recoveryCase: RecoveryCase,
    reference: string,
    via: RecoveryAction,
  ): ObservationResult {
    const now = this.clock.now();

    // The amount recovered is the amount that was at risk. It is written here,
    // in one place, and only alongside a confirmed provider reference.
    const recovered = this.cases.transitionState({
      caseId: recoveryCase.id,
      to: RecoveryState.RECOVERED,
      trigger: "payment_confirmed",
      at: now,
      detail: `Confirmed via ${via} (${reference})`,
      recoveredAmountPaise: recoveryCase.amountPaise,
      actor: "outcome_tracker",
    });

    this.payments.updateStatus(recoveryCase.paymentId, PaymentStatus.CAPTURED, now);
    this.customers.recordSuccessfulPayment(recoveryCase.customerId, recoveryCase.amountPaise, now);

    this.audit.append({
      at: now,
      caseId: recoveryCase.id,
      event: "REVENUE_RECOVERED",
      actor: "outcome_tracker",
      detail: {
        amountPaise: recoveryCase.amountPaise,
        via,
        providerReference: reference,
        hoursToRecovery: Number(hoursBetween(recoveryCase.openedAt, now).toFixed(2)),
      },
    });

    return {
      caseId: recoveryCase.id,
      state: recovered.state,
      recovered: true,
      recoveredAmountPaise: recoveryCase.amountPaise,
      detail: `Payment confirmed via ${via}`,
    };
  }
}
