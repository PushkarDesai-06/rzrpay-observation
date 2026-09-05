import type { Database } from "@/db/client";
import type { AuditEntry } from "@/core/domain/types";
import { newAuditId } from "@/core/domain/ids";
import { toIso } from "@/core/clock";
import { toAuditEntry, type Row } from "@/db/repositories/mappers";

/**
 * Append-only writer for the audit trail.
 *
 * There is deliberately no update or delete method here, and the database
 * rejects both regardless. The trail answers one question: why did the agent
 * take this action?
 */
export class AuditRepository {
  constructor(private readonly db: Database) {}

  append(entry: {
    at: Date;
    caseId: string | null;
    event: string;
    actor: string;
    detail: Record<string, unknown>;
  }): string {
    const id = newAuditId();
    this.db
      .prepare(
        `INSERT INTO audit_log (id, at, case_id, event, actor, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, toIso(entry.at), entry.caseId, entry.event, entry.actor, JSON.stringify(entry.detail));
    return id;
  }

  forCase(caseId: string): AuditEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM audit_log WHERE case_id = ? ORDER BY at ASC, rowid ASC`)
        .all(caseId) as Row[]
    ).map(toAuditEntry);
  }

  recent(limit = 100): AuditEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM audit_log ORDER BY at DESC, rowid DESC LIMIT ?`)
        .all(limit) as Row[]
    ).map(toAuditEntry);
  }
}
