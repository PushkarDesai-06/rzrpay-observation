import type { Database } from "@/db/client";
import type { RecordedDecision, RecoveryDecision } from "@/core/domain/types";
import type { DecisionSource, Diagnosis, Recoverability, RecoveryAction } from "@/core/domain/enums";
import { newDecisionId } from "@/core/domain/ids";
import { toIso, fromIso } from "@/core/clock";
import type { Row } from "@/db/repositories/mappers";

function toDecision(row: Row): RecordedDecision {
  return {
    id: String(row.id),
    caseId: String(row.case_id),
    cycle: Number(row.cycle),
    diagnosis: String(row.diagnosis) as Diagnosis,
    recoverability: String(row.recoverability) as Recoverability,
    confidence: Number(row.confidence),
    recommendedAction: String(row.recommended_action) as RecoveryAction,
    reasoningSummary: String(row.reasoning_summary),
    expectedValuePaise: Number(row.expected_value_paise),
    source: String(row.decision_source) as DecisionSource,
    model: row.model === null || row.model === undefined ? null : String(row.model),
    latencyMs: row.latency_ms === null || row.latency_ms === undefined ? null : Number(row.latency_ms),
    createdAt: fromIso(String(row.created_at)),
  };
}

/**
 * Decisions are written once and never amended — the table rejects UPDATE.
 * `decision_source` travels with every row so a heuristic fallback is never
 * later mistaken for, or displayed as, a model decision.
 */
export class DecisionRepository {
  constructor(private readonly db: Database) {}

  record(params: {
    caseId: string;
    cycle: number;
    decision: RecoveryDecision;
    source: DecisionSource;
    model: string | null;
    latencyMs: number | null;
    context: unknown;
    rawResponse?: unknown;
    at: Date;
  }): RecordedDecision {
    const id = newDecisionId();
    this.db
      .prepare(
        `INSERT INTO recovery_decisions
           (id, case_id, cycle, diagnosis, recoverability, confidence, recommended_action,
            reasoning_summary, expected_value_paise, decision_source, model, latency_ms,
            context_json, raw_response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.caseId,
        params.cycle,
        params.decision.diagnosis,
        params.decision.recoverability,
        params.decision.confidence,
        params.decision.recommendedAction,
        params.decision.reasoningSummary,
        params.decision.expectedValuePaise,
        params.source,
        params.model,
        params.latencyMs,
        JSON.stringify(params.context),
        params.rawResponse === undefined ? null : JSON.stringify(params.rawResponse),
        toIso(params.at),
      );
    return this.require(id);
  }

  require(id: string): RecordedDecision {
    const row = this.db.prepare(`SELECT * FROM recovery_decisions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) throw new Error(`Decision not found: ${id}`);
    return toDecision(row);
  }

  forCase(caseId: string): RecordedDecision[] {
    return (
      this.db
        .prepare(`SELECT * FROM recovery_decisions WHERE case_id = ? ORDER BY cycle ASC`)
        .all(caseId) as Row[]
    ).map(toDecision);
  }

  latestForCase(caseId: string): RecordedDecision | null {
    const row = this.db
      .prepare(`SELECT * FROM recovery_decisions WHERE case_id = ? ORDER BY cycle DESC LIMIT 1`)
      .get(caseId) as Row | undefined;
    return row ? toDecision(row) : null;
  }
}
