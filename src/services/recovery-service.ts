import type { Database } from "@/db/client";
import type { Clock } from "@/core/clock";
import { HOUR_MS, MINUTE_MS } from "@/core/clock";
import {
  ActionStatus,
  RecoveryAction,
  RecoveryState,
  Recoverability,
} from "@/core/domain/enums";
import type { RecoveryCase } from "@/core/domain/types";
import { evaluate as evaluatePolicy, PolicyOutcome, type PolicyFacts } from "@/core/policy/policy-engine";
import type { RecoveryPolicy } from "@/core/policy/policy-config";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import type { RecoveryAgent } from "@/core/agent/recovery-agent";
import { ContextBuilder } from "@/services/context-builder";
import { ActionExecutor, type ExecutionOutcome } from "@/services/action-executor";
import { OutcomeTracker } from "@/services/outcome-tracker";
import { CaseRepository } from "@/db/repositories/case-repository";
import { CustomerRepository } from "@/db/repositories/customer-repository";
import { PaymentRepository } from "@/db/repositories/payment-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { DecisionRepository } from "@/db/repositories/decision-repository";
import { PolicyRepository } from "@/db/repositories/policy-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";
import type { PaymentProvider } from "@/providers/payment-provider";
import type { Notifier } from "@/providers/notifier";
import { FailureCode } from "@/core/domain/enums";

export interface CycleResult {
  caseId: string;
  cycle: number;
  finalState: RecoveryState;
  decisionSource: string;
  proposedAction: RecoveryAction;
  effectiveAction: RecoveryAction | null;
  policyOutcome: string;
  policyRule: string;
  policyReason: string;
  overridden: boolean;
  execution: ExecutionOutcome | null;
  note: string;
}

export interface TickResult {
  evaluated: number;
  observed: number;
  recovered: number;
  recoveredAmountPaise: number;
  cycles: CycleResult[];
}

/**
 * Drives one full turn of the recovery loop for one case:
 *
 *   analyse -> decide -> validate -> act -> schedule
 *
 * It is the only writer of case state during a cycle, and every step it takes
 * is recorded before the next begins, so a case interrupted midway is left in a
 * legible state rather than an ambiguous one.
 */
export class RecoveryService {
  private readonly cases: CaseRepository;
  private readonly customers: CustomerRepository;
  private readonly payments: PaymentRepository;
  private readonly actions: ActionRepository;
  private readonly decisions: DecisionRepository;
  private readonly policies: PolicyRepository;
  private readonly audit: AuditRepository;
  private readonly context: ContextBuilder;
  private readonly executor: ActionExecutor;
  private readonly tracker: OutcomeTracker;

  constructor(
    private readonly db: Database,
    private readonly agent: RecoveryAgent,
    provider: PaymentProvider,
    notifier: Notifier,
    private readonly clock: Clock,
    private readonly policy: RecoveryPolicy = DEFAULT_POLICY,
  ) {
    this.cases = new CaseRepository(db);
    this.customers = new CustomerRepository(db);
    this.payments = new PaymentRepository(db);
    this.actions = new ActionRepository(db);
    this.decisions = new DecisionRepository(db);
    this.policies = new PolicyRepository(db);
    this.audit = new AuditRepository(db);
    this.context = new ContextBuilder(db, policy);
    this.executor = new ActionExecutor(db, provider, notifier, clock);
    this.tracker = new OutcomeTracker(db, provider, clock, policy);
  }

  /** One analyse-decide-validate-act cycle. */
  async evaluate(caseId: string): Promise<CycleResult> {
    const now = this.clock.now();
    let recoveryCase = this.cases.requireById(caseId);

    if (recoveryCase.closedAt !== null) {
      return this.skipped(recoveryCase, `Case is closed in state ${recoveryCase.state}`);
    }

    // Enter analysis from whichever holding state the case is in.
    if (recoveryCase.state !== RecoveryState.ANALYZING) {
      recoveryCase = this.cases.transitionState({
        caseId,
        to: RecoveryState.ANALYZING,
        trigger: "evaluation_started",
        at: now,
      });
    }

    const cycle = this.cases.beginCycle(caseId, now);
    recoveryCase = this.cases.requireById(caseId);

    // ---- Analyse & decide -------------------------------------------------
    const context = this.context.build(recoveryCase, now);
    const agentResult = await this.agent.decide(context);
    const decision = agentResult.decision;

    const recorded = this.decisions.record({
      caseId,
      cycle,
      decision,
      source: agentResult.source,
      model: agentResult.model,
      latencyMs: agentResult.latencyMs,
      context,
      rawResponse: agentResult.raw,
      at: this.clock.now(),
    });
    this.cases.recordAssessment({
      caseId,
      diagnosis: decision.diagnosis,
      recoverability: decision.recoverability,
      confidence: decision.confidence,
      at: this.clock.now(),
    });
    this.audit.append({
      at: this.clock.now(),
      caseId,
      event: "AGENT_DECISION",
      actor: agentResult.source === "llm" ? "recovery_agent" : "heuristic_decider",
      detail: {
        cycle,
        diagnosis: decision.diagnosis,
        recoverability: decision.recoverability,
        confidence: decision.confidence,
        recommendedAction: decision.recommendedAction,
        reasoningSummary: decision.reasoningSummary,
        decisionSource: agentResult.source,
        model: agentResult.model,
        ...(agentResult.warnings.length > 0 ? { warnings: agentResult.warnings } : {}),
      },
    });

    // An unrecoverable case ends here, before any intervention is considered.
    if (decision.recoverability === Recoverability.NOT_RECOVERABLE) {
      const closed = this.cases.transitionState({
        caseId,
        to: RecoveryState.NOT_RECOVERABLE,
        trigger: "assessed_not_recoverable",
        at: this.clock.now(),
        detail: decision.reasoningSummary,
      });
      return {
        caseId,
        cycle,
        finalState: closed.state,
        decisionSource: agentResult.source,
        proposedAction: decision.recommendedAction,
        effectiveAction: null,
        policyOutcome: "NOT_EVALUATED",
        policyRule: "—",
        policyReason: "Assessed as not recoverable before policy validation",
        overridden: false,
        execution: null,
        note: decision.reasoningSummary,
      };
    }

    this.cases.transitionState({
      caseId,
      to: RecoveryState.RECOVERY_CANDIDATE,
      trigger: "recoverable",
      at: this.clock.now(),
      detail: `Recoverability ${decision.recoverability}`,
    });
    recoveryCase = this.cases.transitionState({
      caseId,
      to: RecoveryState.ACTION_PLANNED,
      trigger: "action_selected",
      at: this.clock.now(),
      detail: decision.recommendedAction,
    });

    // ---- Validate ---------------------------------------------------------
    const policyResult = evaluatePolicy({
      recoveryCase,
      decision,
      facts: this.gatherFacts(recoveryCase),
      policy: this.policy,
      now: this.clock.now(),
    });

    this.policies.record({
      caseId,
      decisionId: recorded.id,
      cycle,
      approved: policyResult.outcome === PolicyOutcome.APPROVED,
      originalAction: policyResult.originalAction,
      effectiveAction: policyResult.effectiveAction,
      ruleCode: policyResult.ruleCode,
      reason: policyResult.reason,
      restrictions: policyResult.restrictions,
      at: this.clock.now(),
    });
    this.audit.append({
      at: this.clock.now(),
      caseId,
      event: policyResult.outcome === PolicyOutcome.APPROVED ? "POLICY_APPROVED" : "POLICY_BLOCKED",
      actor: "policy_engine",
      detail: {
        cycle,
        outcome: policyResult.outcome,
        proposed: policyResult.originalAction,
        effective: policyResult.effectiveAction,
        rule: policyResult.ruleCode,
        reason: policyResult.reason,
        overridden: policyResult.overridden,
      },
    });

    const shared = {
      caseId,
      cycle,
      decisionSource: agentResult.source,
      proposedAction: policyResult.originalAction,
      effectiveAction: policyResult.effectiveAction,
      policyOutcome: policyResult.outcome,
      policyRule: policyResult.ruleCode,
      policyReason: policyResult.reason,
      overridden: policyResult.overridden,
    };

    // ---- Act --------------------------------------------------------------
    switch (policyResult.outcome) {
      case PolicyOutcome.ESCALATE: {
        const closed = this.cases.transitionState({
          caseId,
          to: RecoveryState.ESCALATED,
          trigger: "policy_escalation",
          at: this.clock.now(),
          detail: policyResult.reason,
          actor: "policy_engine",
        });
        return { ...shared, finalState: closed.state, execution: null, note: policyResult.reason };
      }

      case PolicyOutcome.STOP: {
        const closed = this.cases.transitionState({
          caseId,
          to: RecoveryState.STOPPED,
          trigger: "policy_stop",
          at: this.clock.now(),
          detail: policyResult.reason,
          actor: "policy_engine",
        });
        return { ...shared, finalState: closed.state, execution: null, note: policyResult.reason };
      }

      case PolicyOutcome.BLOCKED: {
        const blocked = this.cases.transitionState({
          caseId,
          to: RecoveryState.BLOCKED_BY_POLICY,
          trigger: "policy_block",
          at: this.clock.now(),
          detail: `${policyResult.ruleCode}: ${policyResult.reason}`,
          actor: "policy_engine",
        });
        // Hold, then reconsider — a block is rarely permanent.
        this.cases.scheduleNextEvaluation(caseId, new Date(this.clock.now().getTime() + HOUR_MS));
        return { ...shared, finalState: blocked.state, execution: null, note: policyResult.reason };
      }

      case PolicyOutcome.APPROVED: {
        const approved = policyResult.approvedAction;
        if (!approved) {
          throw new Error("Policy approved an action without minting a permission slip");
        }

        this.cases.transitionState({
          caseId,
          to: RecoveryState.POLICY_VALIDATED,
          trigger: "policy_approved",
          at: this.clock.now(),
          detail: approved.action,
          actor: "policy_engine",
        });
        recoveryCase = this.cases.transitionState({
          caseId,
          to: RecoveryState.ACTION_EXECUTING,
          trigger: "execution_started",
          at: this.clock.now(),
          detail: approved.action,
        });

        const execution = await this.executor.execute(approved, {
          recoveryCase,
          payment: this.payments.require(recoveryCase.paymentId),
          customer: this.customers.require(recoveryCase.customerId),
        });

        // A failed external call is not the end of the case: re-plan if the
        // policy still permits an attempt, fail explicitly if it does not.
        if (execution.status === ActionStatus.FAILED) {
          const canRetryLater =
            this.actions.countAttempted(caseId, RecoveryAction.RETRY_PAYMENT) <
            this.policy.maxPaymentRetries;

          const next = canRetryLater ? RecoveryState.ANALYZING : RecoveryState.FAILED;
          const updated = this.cases.transitionState({
            caseId,
            to: next,
            trigger: "action_failed",
            at: this.clock.now(),
            detail: execution.error ?? "action failed",
          });
          if (next === RecoveryState.ANALYZING) {
            this.cases.scheduleNextEvaluation(
              caseId,
              new Date(this.clock.now().getTime() + this.policy.minimumRetryIntervalMinutes * MINUTE_MS),
            );
          }
          return {
            ...shared,
            finalState: updated.state,
            execution,
            note: execution.error ?? "Action failed",
          };
        }

        const waiting = this.cases.transitionState({
          caseId,
          to: RecoveryState.WAITING_FOR_OUTCOME,
          trigger: "awaiting_outcome",
          at: this.clock.now(),
          detail: approved.action,
        });
        this.cases.scheduleNextEvaluation(
          caseId,
          this.nextEvaluationAfter(approved.action, recoveryCase),
        );

        return {
          ...shared,
          finalState: waiting.state,
          execution,
          note: `Executed ${approved.action} via ${execution.provider}`,
        };
      }

      default:
        throw new Error(`Unhandled policy outcome: ${policyResult.outcome}`);
    }
  }

  /**
   * Advance the whole system: observe pending outcomes, then evaluate whatever
   * is due. Observation runs first so a case whose payment has landed is closed
   * before anything else is attempted on it.
   */
  async tick(): Promise<TickResult> {
    const now = this.clock.now();
    const result: TickResult = {
      evaluated: 0,
      observed: 0,
      recovered: 0,
      recoveredAmountPaise: 0,
      cycles: [],
    };

    for (const pending of this.cases.list({ state: RecoveryState.WAITING_FOR_OUTCOME })) {
      if (pending.nextEvaluationAt && pending.nextEvaluationAt.getTime() > now.getTime()) continue;
      const observation = await this.tracker.observe(pending);
      result.observed += 1;
      if (observation.recovered) {
        result.recovered += 1;
        result.recoveredAmountPaise += observation.recoveredAmountPaise ?? 0;
      }
    }

    for (const due of this.cases.dueForEvaluation(now)) {
      const fresh = this.cases.requireById(due.id);
      if (fresh.closedAt !== null) continue;
      if (fresh.state === RecoveryState.WAITING_FOR_OUTCOME) continue;
      result.cycles.push(await this.evaluate(fresh.id));
      result.evaluated += 1;
    }

    return result;
  }

  /**
   * Read the enforcement facts straight from the ledger.
   *
   * Deliberately independent of the context the agent was shown: what the model
   * believed about its remaining budget has no bearing on what is permitted.
   */
  private gatherFacts(recoveryCase: RecoveryCase): PolicyFacts {
    const payment = this.payments.require(recoveryCase.paymentId);
    const reminders = this.actions.countSucceeded(recoveryCase.id, RecoveryAction.SEND_REMINDER);
    const links = this.actions.countSucceeded(recoveryCase.id, RecoveryAction.CREATE_PAYMENT_LINK);

    return {
      retriesAttempted: this.actions.countAttempted(recoveryCase.id, RecoveryAction.RETRY_PAYMENT),
      remindersSent: reminders,
      paymentLinksCreated: links,
      customerMessagesSent: reminders + links,
      hasOpenPaymentLink: this.actions.hasOpenPaymentLink(recoveryCase.id),
      lastRetryAt: this.actions.lastOf(recoveryCase.id, RecoveryAction.RETRY_PAYMENT)?.createdAt ?? null,
      lastCustomerContactAt: this.actions.lastCustomerContact(recoveryCase.id)?.createdAt ?? null,
      actionsInTrailingDay: this.actions.countSince(new Date(this.clock.now().getTime() - 24 * HOUR_MS)),
      failureCode: payment.failureCode ?? FailureCode.UNKNOWN,
    };
  }

  /**
   * When this case next deserves attention.
   *
   * For an executed intervention this is a polling interval. For WAIT it is
   * computed from the constraint the case is actually waiting on — waking a
   * waiting case on a blind timer just to conclude "not yet" burns a full
   * evaluation cycle, and with a model behind the agent that is a real API
   * call each time. Waking when the constraint lifts answers the same question
   * once.
   */
  private nextEvaluationAfter(action: RecoveryAction, recoveryCase: RecoveryCase): Date {
    const now = this.clock.now();
    const windowEnds = new Date(
      recoveryCase.openedAt.getTime() + this.policy.maximumRecoveryDurationHours * HOUR_MS,
    );

    const at = (ms: number): Date => new Date(now.getTime() + ms);

    let next: Date;
    switch (action) {
      case RecoveryAction.RETRY_PAYMENT:
        next = at(5 * MINUTE_MS);
        break;
      case RecoveryAction.CREATE_PAYMENT_LINK:
        next = at(6 * HOUR_MS);
        break;
      case RecoveryAction.SEND_REMINDER:
        next = at(12 * HOUR_MS);
        break;
      case RecoveryAction.WAIT:
        next = this.whenAConstraintLifts(recoveryCase, now);
        break;
      default:
        next = at(HOUR_MS);
    }

    // Never schedule past the point where the case would be stopped anyway.
    return next.getTime() > windowEnds.getTime() ? windowEnds : next;
  }

  /**
   * The earliest moment a policy limit stops binding, so a WAIT resolves into a
   * real decision on the next cycle rather than another WAIT.
   */
  private whenAConstraintLifts(recoveryCase: RecoveryCase, now: Date): Date {
    const facts = this.gatherFacts(recoveryCase);
    const candidates: number[] = [];

    if (facts.lastRetryAt && facts.retriesAttempted < this.policy.maxPaymentRetries) {
      candidates.push(
        facts.lastRetryAt.getTime() + this.policy.minimumRetryIntervalMinutes * MINUTE_MS,
      );
    }
    if (facts.lastCustomerContactAt && facts.remindersSent < this.policy.maxReminders) {
      candidates.push(
        facts.lastCustomerContactAt.getTime() + this.policy.minimumMessageIntervalHours * HOUR_MS,
      );
    }

    const future = candidates.filter((t) => t > now.getTime());
    if (future.length === 0) {
      // Nothing time-based is pending; fall back to a slow heartbeat.
      return new Date(now.getTime() + this.policy.minimumRetryIntervalMinutes * MINUTE_MS);
    }
    return new Date(Math.min(...future));
  }

  private skipped(recoveryCase: RecoveryCase, note: string): CycleResult {
    return {
      caseId: recoveryCase.id,
      cycle: recoveryCase.cycleCount,
      finalState: recoveryCase.state,
      decisionSource: "none",
      proposedAction: RecoveryAction.STOP,
      effectiveAction: null,
      policyOutcome: "SKIPPED",
      policyRule: "—",
      policyReason: note,
      overridden: false,
      execution: null,
      note,
    };
  }
}
