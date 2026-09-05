import type { Database } from "@/db/client";
import type { Clock } from "@/core/clock";
import {
  ActionStatus,
  PaymentStatus,
  ProviderKind,
  RecoveryAction,
} from "@/core/domain/enums";
import type { Customer, Payment, RecoveryCase } from "@/core/domain/types";
import type { Paise } from "@/core/domain/money";
import { ApprovedAction } from "@/core/policy/policy-engine";
import { actionIdempotencyKey } from "@/core/domain/ids";
import { ActionRepository } from "@/db/repositories/action-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";
import type { PaymentProvider } from "@/providers/payment-provider";
import type { Notifier } from "@/providers/notifier";

export interface ExecutionOutcome {
  actionId: string;
  action: RecoveryAction;
  status: ActionStatus;
  success: boolean;
  provider: ProviderKind;
  externalRef: string | null;
  error: string | null;
  /** True only when the provider confirmed a captured payment in this call. */
  paymentCaptured: boolean;
  capturedAmountPaise: Paise | null;
  /** Set when a payment link was created, so the tracker knows what to poll. */
  paymentLinkId: string | null;
  /**
   * The payable URL. Persisted alongside the id because a later reminder has
   * to send the customer somewhere, and the id alone is not a destination.
   */
  paymentLinkUrl: string | null;
}

export class UnapprovedActionError extends Error {
  constructor(detail: string) {
    super(`Refusing to execute an action that was not approved by the policy engine: ${detail}`);
    this.name = "UnapprovedActionError";
  }
}

/**
 * Performs exactly the action the policy engine permitted.
 *
 * Two guarantees.
 *
 * It will only accept an `ApprovedAction`, whose constructor is private to the
 * policy engine — so there is no route from an agent decision to an external
 * API that skips validation. A forged lookalike fails the `instanceof` check
 * and is rejected before any provider is touched.
 *
 * It claims the action's idempotency key in the database *before* making the
 * external call. A redelivered event, a re-run tick or a crash-and-retry
 * therefore cannot charge a card or email a customer twice — the second attempt
 * finds the key taken and returns without calling anything.
 */
export class ActionExecutor {
  private readonly actions: ActionRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly provider: PaymentProvider,
    private readonly notifier: Notifier,
    private readonly clock: Clock,
  ) {
    this.actions = new ActionRepository(db);
    this.audit = new AuditRepository(db);
  }

  async execute(
    approved: ApprovedAction,
    subject: { recoveryCase: RecoveryCase; payment: Payment; customer: Customer },
  ): Promise<ExecutionOutcome> {
    if (!(approved instanceof ApprovedAction)) {
      throw new UnapprovedActionError("value did not originate from the policy engine");
    }
    if (approved.caseId !== subject.recoveryCase.id) {
      throw new UnapprovedActionError(
        `approval is for case ${approved.caseId}, not ${subject.recoveryCase.id}`,
      );
    }

    const now = this.clock.now();
    const key = actionIdempotencyKey(approved.caseId, approved.action, approved.cycle);

    const { action: record, claimed } = this.actions.claim({
      caseId: approved.caseId,
      cycle: approved.cycle,
      action: approved.action,
      idempotencyKey: key,
      provider: this.providerFor(approved.action),
      request: {
        paymentId: subject.payment.id,
        amountPaise: subject.recoveryCase.amountPaise,
        ruleCode: approved.ruleCode,
        reason: approved.reason,
      },
      at: now,
    });

    if (!claimed) {
      this.audit.append({
        at: now,
        caseId: approved.caseId,
        event: "ACTION_SKIPPED_DUPLICATE",
        actor: "action_executor",
        detail: { action: approved.action, idempotencyKey: key, existingActionId: record.id },
      });
      return {
        actionId: record.id,
        action: approved.action,
        status: ActionStatus.SKIPPED_DUPLICATE,
        success: false,
        provider: record.provider,
        externalRef: record.externalRef,
        error: null,
        paymentCaptured: false,
        capturedAmountPaise: null,
        paymentLinkId: null,
        paymentLinkUrl: null,
      };
    }

    this.audit.append({
      at: now,
      caseId: approved.caseId,
      event: "ACTION_EXECUTING",
      actor: "action_executor",
      detail: {
        action: approved.action,
        provider: this.providerFor(approved.action),
        ruleCode: approved.ruleCode,
        idempotencyKey: key,
      },
    });

    try {
      const outcome = await this.dispatch(approved, subject, record.id);
      this.actions.complete({
        actionId: record.id,
        status: outcome.status,
        externalRef: outcome.externalRef,
        result: {
          outcome: outcome.success ? "succeeded" : "failed",
          paymentCaptured: outcome.paymentCaptured,
          ...(outcome.paymentLinkId ? { paymentLinkId: outcome.paymentLinkId } : {}),
          ...(outcome.paymentLinkUrl ? { paymentLinkUrl: outcome.paymentLinkUrl } : {}),
        },
        error: outcome.error,
        at: this.clock.now(),
      });
      this.audit.append({
        at: this.clock.now(),
        caseId: approved.caseId,
        event: outcome.success ? "ACTION_SUCCEEDED" : "ACTION_FAILED",
        actor: "action_executor",
        detail: {
          action: approved.action,
          provider: outcome.provider,
          externalRef: outcome.externalRef,
          error: outcome.error,
        },
      });
      return outcome;
    } catch (error) {
      // A provider that throws is recorded, never swallowed.
      const message = error instanceof Error ? error.message : String(error);
      this.actions.complete({
        actionId: record.id,
        status: ActionStatus.FAILED,
        error: message,
        at: this.clock.now(),
      });
      this.audit.append({
        at: this.clock.now(),
        caseId: approved.caseId,
        event: "ACTION_FAILED",
        actor: "action_executor",
        detail: { action: approved.action, error: message },
      });
      return {
        actionId: record.id,
        action: approved.action,
        status: ActionStatus.FAILED,
        success: false,
        provider: this.providerFor(approved.action),
        externalRef: null,
        error: message,
        paymentCaptured: false,
        capturedAmountPaise: null,
        paymentLinkId: null,
        paymentLinkUrl: null,
      };
    }
  }

  private providerFor(action: RecoveryAction): ProviderKind {
    switch (action) {
      case RecoveryAction.RETRY_PAYMENT:
      case RecoveryAction.CREATE_PAYMENT_LINK:
        // Ask the provider, since a composite routes these to different
        // backends and the row must name the one that actually ran.
        return this.provider.kindFor?.(action) ?? this.provider.kind;
      case RecoveryAction.SEND_REMINDER:
        return ProviderKind.OUTBOX;
      default:
        return ProviderKind.NONE;
    }
  }

  private async dispatch(
    approved: ApprovedAction,
    subject: { recoveryCase: RecoveryCase; payment: Payment; customer: Customer },
    actionId: string,
  ): Promise<ExecutionOutcome> {
    const base = {
      actionId,
      action: approved.action,
      provider: this.providerFor(approved.action),
      paymentCaptured: false,
      capturedAmountPaise: null as Paise | null,
      paymentLinkId: null as string | null,
      paymentLinkUrl: null as string | null,
    };

    switch (approved.action) {
      case RecoveryAction.RETRY_PAYMENT: {
        const result = await this.provider.retryPayment({
          paymentId: subject.payment.id,
          amountPaise: subject.recoveryCase.amountPaise,
          currency: subject.recoveryCase.currency,
          idempotencyKey: actionIdempotencyKey(approved.caseId, approved.action, approved.cycle),
        });
        return {
          ...base,
          provider: result.provider,
          status: result.success ? ActionStatus.SUCCEEDED : ActionStatus.FAILED,
          success: result.success,
          externalRef: result.externalReference,
          error: result.success ? null : (result.failureReasonRaw ?? "retry failed"),
          paymentCaptured: result.success && result.status === PaymentStatus.CAPTURED,
          capturedAmountPaise: result.success ? subject.recoveryCase.amountPaise : null,
        };
      }

      case RecoveryAction.CREATE_PAYMENT_LINK: {
        const link = await this.provider.createRecoveryLink({
          caseId: approved.caseId,
          paymentId: subject.payment.id,
          customerId: subject.customer.id,
          customerName: subject.customer.name,
          customerEmail: subject.customer.email,
          amountPaise: subject.recoveryCase.amountPaise,
          currency: subject.recoveryCase.currency,
          idempotencyKey: actionIdempotencyKey(approved.caseId, approved.action, approved.cycle),
          expiresAt: new Date(this.clock.now().getTime() + 72 * 3_600_000),
        });

        if (!link.success || !link.linkId) {
          return {
            ...base,
            provider: link.provider,
            status: ActionStatus.FAILED,
            success: false,
            externalRef: null,
            error: link.error ?? "payment link creation failed",
          };
        }

        // Creating the link is only half the intervention; the customer has to
        // receive it. A delivery failure fails the whole action.
        const delivery = await this.notifier.send({
          caseId: approved.caseId,
          customerId: subject.customer.id,
          actionId,
          recipient: subject.customer.email,
          customerName: subject.customer.name,
          amountPaise: subject.recoveryCase.amountPaise,
          paymentLinkUrl: link.url,
          kind: "payment_link",
        });

        return {
          ...base,
          provider: link.provider,
          status: delivery.delivered ? ActionStatus.SUCCEEDED : ActionStatus.FAILED,
          success: delivery.delivered,
          externalRef: link.linkId,
          error: delivery.error,
          paymentLinkId: link.linkId,
          paymentLinkUrl: link.url,
        };
      }

      case RecoveryAction.SEND_REMINDER: {
        const priorLink = this.actions
          .forCase(approved.caseId)
          .find((a) => a.action === RecoveryAction.CREATE_PAYMENT_LINK && a.externalRef);
        const existingLinkId = priorLink?.externalRef;
        // Prefer the URL recorded when the link was made; a bare id is not
        // something a customer can pay.
        const existingLinkUrl = readLinkUrl(priorLink?.result);

        const delivery = await this.notifier.send({
          caseId: approved.caseId,
          customerId: subject.customer.id,
          actionId,
          recipient: subject.customer.email,
          customerName: subject.customer.name,
          amountPaise: subject.recoveryCase.amountPaise,
          paymentLinkUrl: existingLinkUrl ?? (existingLinkId ? `link:${existingLinkId}` : null),
          kind: "reminder",
        });

        if (delivery.delivered && existingLinkId) {
          this.provider.notePaymentLinkReminder?.(existingLinkId);
        }

        return {
          ...base,
          provider: ProviderKind.OUTBOX,
          status: delivery.delivered ? ActionStatus.SUCCEEDED : ActionStatus.FAILED,
          success: delivery.delivered,
          externalRef: delivery.reference,
          error: delivery.error,
        };
      }

      case RecoveryAction.WAIT:
        // Doing nothing is a real, recorded decision — not an absence of one.
        return {
          ...base,
          provider: ProviderKind.NONE,
          status: ActionStatus.SUCCEEDED,
          success: true,
          externalRef: null,
          error: null,
        };

      default:
        throw new UnapprovedActionError(`${approved.action} is not executable`);
    }
  }
}

/**
 * Pull the payable URL out of a recorded action's result.
 *
 * Older rows predate the field and hold only the link id, so this returns null
 * rather than inventing a URL — the caller falls back to the id.
 */
export function readLinkUrl(result: Record<string, unknown> | null | undefined): string | null {
  const url = result?.paymentLinkUrl;
  return typeof url === "string" && url.length > 0 ? url : null;
}
