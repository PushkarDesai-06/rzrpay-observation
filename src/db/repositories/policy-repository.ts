import type { Database } from "@/db/client";
import type { RecoveryAction } from "@/core/domain/enums";
import { newPolicyEvaluationId } from "@/core/domain/ids";
import { toIso, fromIso } from "@/core/clock";
import { toSqlBool, fromSqlBool } from "@/db/client";
import type { Row } from "@/db/repositories/mappers";

export interface RecordedPolicyEvaluation {
  id: string;
  caseId: string;
  decisionId: string | null;
  cycle: number;
  approved: boolean;
  originalAction: RecoveryAction;
  effectiveAction: RecoveryAction | null;
  ruleCode: string;
  reason: string;
  restrictions: string[];
  createdAt: Date;
}

function toEvaluation(row: Row): RecordedPolicyEvaluation {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    decisionId: row.decision_id === null || row.decision_id === undefined ? null : String(row.decision_id),
    cycle: Number(row.cycle),
    approved: fromSqlBool(Number(row.approved)),
    originalAction: String(row.original_action) as RecoveryAction,
    effectiveAction:
      row.effective_action === null || row.effective_action === undefined
        ? null
        : (String(row.effective_action) as RecoveryAction),
    ruleCode: String(row.rule_code),
    reason: String(row.reason),
    restrictions: row.restrictions_json ? (JSON.parse(String(row.restrictions_json)) as string[]) : [],
    createdAt: fromIso(String(row.created_at)),
  };
}

/** Every policy verdict is persisted — approvals and blocks alike. */
export class PolicyRepository {
  constructor(private readonly db: Database) {}

  record(params: {
    caseId: string;
    decisionId: string | null;
    cycle: number;
    approved: boolean;
    originalAction: RecoveryAction;
    effectiveAction: RecoveryAction | null;
    ruleCode: string;
    reason: string;
    restrictions: string[];
    at: Date;
  }): RecordedPolicyEvaluation {
    const id = newPolicyEvaluationId();
    this.db
      .prepare(
        `INSERT INTO policy_evaluations
           (id, case_id, decision_id, cycle, approved, original_action, effective_action,
            rule_code, reason, restrictions_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.caseId,
        params.decisionId,
        params.cycle,
        toSqlBool(params.approved),
        params.originalAction,
        params.effectiveAction,
        params.ruleCode,
        params.reason,
        JSON.stringify(params.restrictions),
        toIso(params.at),
      );
    const row = this.db.prepare(`SELECT * FROM policy_evaluations WHERE id = ?`).get(id) as Row;
    return toEvaluation(row);
  }

  forCase(caseId: string): RecordedPolicyEvaluation[] {
    return (
      this.db
        .prepare(`SELECT * FROM policy_evaluations WHERE case_id = ? ORDER BY created_at ASC, rowid ASC`)
        .all(caseId) as Row[]
    ).map(toEvaluation);
  }

  countBlocked(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM policy_evaluations WHERE approved = 0`)
      .get() as { n: number };
    return Number(row.n);
  }

  blocksByRule(): Array<{ ruleCode: string; count: number }> {
    return (
      this.db
        .prepare(
          `SELECT rule_code, COUNT(*) AS n FROM policy_evaluations
            WHERE approved = 0 GROUP BY rule_code ORDER BY n DESC`,
        )
        .all() as Row[]
    ).map((r) => ({ ruleCode: String(r.rule_code), count: Number(r.n) }));
  }
}
