import type { Database } from "@/db/client";
import type { ActionStatus, ProviderKind, RecoveryAction } from "@/core/domain/enums";
import { ActionStatus as Status, RecoveryAction as Action } from "@/core/domain/enums";
import { newActionId } from "@/core/domain/ids";
import { toIso, fromIso } from "@/core/clock";
import type { Row } from "@/db/repositories/mappers";

export interface RecordedAction {
  id: string;
  caseId: string;
  cycle: number;
  action: RecoveryAction;
  idempotencyKey: string;
  status: ActionStatus;
  provider: ProviderKind;
  externalRef: string | null;
  request: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

function toAction(row: Row): RecordedAction {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    cycle: Number(row.cycle),
    action: String(row.action) as RecoveryAction,
    idempotencyKey: String(row.idempotency_key),
    status: String(row.status) as ActionStatus,
    provider: String(row.provider) as ProviderKind,
    externalRef: row.external_ref === null || row.external_ref === undefined ? null : String(row.external_ref),
    request: row.request_json ? (JSON.parse(String(row.request_json)) as Record<string, unknown>) : null,
    result: row.result_json ? (JSON.parse(String(row.result_json)) as Record<string, unknown>) : null,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: fromIso(String(row.created_at)),
    completedAt: row.completed_at ? fromIso(String(row.completed_at)) : null,
  };
}

export class ActionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Claim an idempotency key before the external call is made.
   *
   * Returns `claimed: false` if this exact action was already executed, which
   * is what stops a redelivered event or a re-run tick from charging a card or
   * emailing a customer twice. The row is written first and completed after,
   * so a crash mid-call leaves evidence rather than a silent gap.
   */
  claim(params: {
    caseId: string;
    cycle: number;
    action: RecoveryAction;
    idempotencyKey: string;
    provider: ProviderKind;
    request: Record<string, unknown>;
    at: Date;
  }): { action: RecordedAction; claimed: boolean } {
    const existing = this.findByIdempotencyKey(params.idempotencyKey);
    if (existing) return { action: existing, claimed: false };

    const id = newActionId();
    try {
      this.db
        .prepare(
          `INSERT INTO recovery_actions
             (id, case_id, cycle, action, idempotency_key, status, provider, request_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          params.caseId,
          params.cycle,
          params.action,
          params.idempotencyKey,
          Status.PENDING,
          params.provider,
          JSON.stringify(params.request),
          toIso(params.at),
        );
    } catch (error) {
      const raced = this.findByIdempotencyKey(params.idempotencyKey);
      if (raced) return { action: raced, claimed: false };
      throw error;
    }
    return { action: this.require(id), claimed: true };
  }

  complete(params: {
    actionId: string;
    status: ActionStatus;
    externalRef?: string | null;
    result?: Record<string, unknown> | null;
    error?: string | null;
    at: Date;
  }): RecordedAction {
    this.db
      .prepare(
        `UPDATE recovery_actions
            SET status = ?, external_ref = ?, result_json = ?, error = ?, completed_at = ?
          WHERE id = ?`,
      )
      .run(
        params.status,
        params.externalRef ?? null,
        params.result ? JSON.stringify(params.result) : null,
        params.error ?? null,
        toIso(params.at),
        params.actionId,
      );
    return this.require(params.actionId);
  }

  findByIdempotencyKey(key: string): RecordedAction | null {
    const row = this.db
      .prepare(`SELECT * FROM recovery_actions WHERE idempotency_key = ?`)
      .get(key) as Row | undefined;
    return row ? toAction(row) : null;
  }

  require(id: string): RecordedAction {
    const row = this.db.prepare(`SELECT * FROM recovery_actions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new Error(`Action not found: ${id}`);
    return toAction(row);
  }

  forCase(caseId: string): RecordedAction[] {
    return (
      this.db
        .prepare(`SELECT * FROM recovery_actions WHERE case_id = ? ORDER BY created_at ASC, rowid ASC`)
        .all(caseId) as Row[]
    ).map(toAction);
  }

  /**
   * Count actions of a kind that actually went through.
   *
   * Failed and duplicate-skipped attempts do not consume a customer's message
   * allowance or a case's retry budget; only work that really happened does.
   */
  countSucceeded(caseId: string, action: RecoveryAction): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM recovery_actions
          WHERE case_id = ? AND action = ? AND status = ?`,
      )
      .get(caseId, action, Status.SUCCEEDED) as { n: number };
    return Number(row.n);
  }

  /** Retry attempts consume budget whether or not the payment then succeeded. */
  countAttempted(caseId: string, action: RecoveryAction): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM recovery_actions
          WHERE case_id = ? AND action = ? AND status IN (?, ?)`,
      )
      .get(caseId, action, Status.SUCCEEDED, Status.FAILED) as { n: number };
    return Number(row.n);
  }

  lastOf(caseId: string, action: RecoveryAction): RecordedAction | null {
    const row = this.db
      .prepare(
        `SELECT * FROM recovery_actions
          WHERE case_id = ? AND action = ? AND status IN ('SUCCEEDED','FAILED')
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(caseId, action) as Row | undefined;
    return row ? toAction(row) : null;
  }

  /** Most recent customer contact of any kind, for the message-spacing rule. */
  lastCustomerContact(caseId: string): RecordedAction | null {
    const row = this.db
      .prepare(
        `SELECT * FROM recovery_actions
          WHERE case_id = ? AND action IN (?, ?) AND status = ?
          ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(caseId, Action.SEND_REMINDER, Action.CREATE_PAYMENT_LINK, Status.SUCCEEDED) as Row | undefined;
    return row ? toAction(row) : null;
  }

  /** An unpaid payment link already exists — creating another would be a duplicate. */
  hasOpenPaymentLink(caseId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM recovery_actions
          WHERE case_id = ? AND action = ? AND status = ?`,
      )
      .get(caseId, Action.CREATE_PAYMENT_LINK, Status.SUCCEEDED) as { n: number };
    return Number(row.n) > 0;
  }

  /** Actions executed system-wide within the trailing window. Backs the kill switch. */
  countSince(since: Date): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM recovery_actions WHERE created_at >= ?`)
      .get(toIso(since)) as { n: number };
    return Number(row.n);
  }
}
