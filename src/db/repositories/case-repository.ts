import type { Database } from "@/db/client";
import { transaction } from "@/db/client";
import type { RecoveryCase, StateTransition } from "@/core/domain/types";
import type { Diagnosis, Recoverability, RecoveryState } from "@/core/domain/enums";
import { RecoveryState as State, isTerminal } from "@/core/domain/enums";
import { assertTransition } from "@/core/state/state-machine";
import { newCaseId, newTransitionId } from "@/core/domain/ids";
import { toIso } from "@/core/clock";
import type { Paise } from "@/core/domain/money";
import { toRecoveryCase, toStateTransition, type Row } from "@/db/repositories/mappers";
import { AuditRepository } from "@/db/repositories/audit-repository";

export class CaseNotFoundError extends Error {
  constructor(caseId: string) {
    super(`Recovery case not found: ${caseId}`);
    this.name = "CaseNotFoundError";
  }
}

/**
 * The only component permitted to write recovery_cases.state.
 *
 * `transitionState` is the single writer, and it always runs the move past the
 * state machine first. That is what makes an illegal transition impossible
 * rather than merely discouraged — there is no second path to the column.
 */
export class CaseRepository {
  private readonly audit: AuditRepository;

  constructor(private readonly db: Database) {
    this.audit = new AuditRepository(db);
  }

  /**
   * Create a case, or return the existing one for this payment.
   *
   * Duplicate failure events for the same payment must never open a second
   * case; the UNIQUE constraint on payment_id backs this up if two callers
   * race.
   */
  createOrGet(params: {
    paymentId: string;
    customerId: string;
    amountPaise: Paise;
    currency: string;
    at: Date;
  }): { case: RecoveryCase; created: boolean } {
    const existing = this.findByPaymentId(params.paymentId);
    if (existing) return { case: existing, created: false };

    const id = newCaseId();
    const now = toIso(params.at);

    return transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO recovery_cases
             (id, payment_id, customer_id, amount_paise, currency, state, cycle_count, opened_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(id, params.paymentId, params.customerId, params.amountPaise, params.currency, State.DETECTED, now, now);

      this.audit.append({
        at: params.at,
        caseId: id,
        event: "CASE_CREATED",
        actor: "detection",
        detail: {
          paymentId: params.paymentId,
          customerId: params.customerId,
          amountPaise: params.amountPaise,
          state: State.DETECTED,
        },
      });

      return { case: this.requireById(id), created: true };
    });
  }

  findById(caseId: string): RecoveryCase | null {
    const row = this.db.prepare(`SELECT * FROM recovery_cases WHERE id = ?`).get(caseId) as Row | undefined;
    return row ? toRecoveryCase(row) : null;
  }

  requireById(caseId: string): RecoveryCase {
    const found = this.findById(caseId);
    if (!found) throw new CaseNotFoundError(caseId);
    return found;
  }

  findByPaymentId(paymentId: string): RecoveryCase | null {
    const row = this.db
      .prepare(`SELECT * FROM recovery_cases WHERE payment_id = ?`)
      .get(paymentId) as Row | undefined;
    return row ? toRecoveryCase(row) : null;
  }

  list(options: { state?: RecoveryState; limit?: number } = {}): RecoveryCase[] {
    const rows = options.state
      ? (this.db
          .prepare(`SELECT * FROM recovery_cases WHERE state = ? ORDER BY opened_at DESC LIMIT ?`)
          .all(options.state, options.limit ?? 200) as Row[])
      : (this.db
          .prepare(`SELECT * FROM recovery_cases ORDER BY opened_at DESC LIMIT ?`)
          .all(options.limit ?? 200) as Row[]);
    return rows.map(toRecoveryCase);
  }

  /** Open cases whose scheduled re-evaluation time has arrived. Drives the tick. */
  dueForEvaluation(now: Date, limit = 100): RecoveryCase[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM recovery_cases
          WHERE closed_at IS NULL
            AND next_evaluation_at IS NOT NULL
            AND next_evaluation_at <= ?
          ORDER BY next_evaluation_at ASC
          LIMIT ?`,
      )
      .all(toIso(now), limit) as Row[];
    return rows.map(toRecoveryCase);
  }

  /**
   * Move a case to a new state.
   *
   * Illegal moves throw before anything is written. The state change, its
   * transition record and its audit entry are one atomic unit, so the timeline
   * can never disagree with the case.
   */
  transitionState(params: {
    caseId: string;
    to: RecoveryState;
    trigger: string;
    at: Date;
    detail?: string;
    recoveredAmountPaise?: Paise;
    actor?: string;
  }): RecoveryCase {
    const current = this.requireById(params.caseId);
    assertTransition(current.state, params.to);

    const markingRecovered = params.to === State.RECOVERED;
    if (markingRecovered && params.recoveredAmountPaise === undefined) {
      throw new Error(
        `Refusing to mark ${params.caseId} RECOVERED without a confirmed recovered amount`,
      );
    }
    if (!markingRecovered && params.recoveredAmountPaise !== undefined) {
      throw new Error(
        `Refusing to record recovered revenue on a case transitioning to ${params.to}`,
      );
    }

    const now = toIso(params.at);
    const closing = isTerminal(params.to);

    return transaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE recovery_cases
              SET state = ?,
                  updated_at = ?,
                  closed_at = CASE WHEN ? = 1 THEN ? ELSE closed_at END,
                  recovered_at = CASE WHEN ? = 1 THEN ? ELSE recovered_at END,
                  recovered_amount_paise = CASE WHEN ? = 1 THEN ? ELSE recovered_amount_paise END,
                  next_evaluation_at = CASE WHEN ? = 1 THEN NULL ELSE next_evaluation_at END
            WHERE id = ?`,
        )
        .run(
          params.to,
          now,
          closing ? 1 : 0,
          now,
          markingRecovered ? 1 : 0,
          now,
          markingRecovered ? 1 : 0,
          params.recoveredAmountPaise ?? null,
          closing ? 1 : 0,
          params.caseId,
        );

      this.db
        .prepare(
          `INSERT INTO case_state_transitions (id, case_id, from_state, to_state, trigger, detail, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(newTransitionId(), params.caseId, current.state, params.to, params.trigger, params.detail ?? null, now);

      this.audit.append({
        at: params.at,
        caseId: params.caseId,
        event: "STATE_TRANSITION",
        actor: params.actor ?? "recovery_service",
        detail: {
          from: current.state,
          to: params.to,
          trigger: params.trigger,
          ...(params.detail !== undefined ? { detail: params.detail } : {}),
          ...(params.recoveredAmountPaise !== undefined
            ? { recoveredAmountPaise: params.recoveredAmountPaise }
            : {}),
        },
      });

      return this.requireById(params.caseId);
    });
  }

  /** Record the agent's assessment on the case. Never touches state. */
  recordAssessment(params: {
    caseId: string;
    diagnosis: Diagnosis;
    recoverability: Recoverability;
    confidence: number;
    at: Date;
  }): void {
    this.db
      .prepare(
        `UPDATE recovery_cases SET diagnosis = ?, recoverability = ?, confidence = ?, updated_at = ? WHERE id = ?`,
      )
      .run(params.diagnosis, params.recoverability, params.confidence, toIso(params.at), params.caseId);
  }

  beginCycle(caseId: string, at: Date): number {
    this.db
      .prepare(`UPDATE recovery_cases SET cycle_count = cycle_count + 1, updated_at = ? WHERE id = ?`)
      .run(toIso(at), caseId);
    return this.requireById(caseId).cycleCount;
  }

  scheduleNextEvaluation(caseId: string, at: Date | null): void {
    this.db
      .prepare(`UPDATE recovery_cases SET next_evaluation_at = ? WHERE id = ?`)
      .run(at ? toIso(at) : null, caseId);
  }

  timeline(caseId: string): StateTransition[] {
    return (
      this.db
        .prepare(`SELECT * FROM case_state_transitions WHERE case_id = ? ORDER BY at ASC, rowid ASC`)
        .all(caseId) as Row[]
    ).map(toStateTransition);
  }
}
