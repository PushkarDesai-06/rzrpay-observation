import type { Database } from "@/db/client";
import type { Clock } from "@/core/clock";
import { hoursBetween, fromIso } from "@/core/clock";
import { ActionStatus, RecoveryAction, RecoveryState } from "@/core/domain/enums";
import type {
  ActionBreakdown,
  CaseCounts,
  DecisionSourceStat,
  DiagnosisBreakdown,
  InterventionCounts,
  MetricsSnapshot,
  PolicyStats,
  RecoveryTiming,
  RevenueTotals,
} from "@/core/metrics/metrics";
import { average, median, safeRate } from "@/core/metrics/metrics";
import type { Row } from "@/db/repositories/mappers";

/**
 * Interventions that actually reach a provider or a customer.
 *
 * WAIT is a real decision and is recorded as an action, but it contacts nobody,
 * so counting it as an attempt would flatter every rate on the dashboard.
 */
const REAL_INTERVENTIONS: readonly RecoveryAction[] = [
  RecoveryAction.RETRY_PAYMENT,
  RecoveryAction.CREATE_PAYMENT_LINK,
  RecoveryAction.SEND_REMINDER,
];

const TERMINAL_SQL = "('RECOVERED','FAILED','NOT_RECOVERABLE','ESCALATED','STOPPED')";

/**
 * Computes every reported number from stored rows.
 *
 * No aggregate is persisted anywhere, so there is no counter that can drift
 * from the underlying facts or be incremented twice.
 */
export class MetricsService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  snapshot(): MetricsSnapshot {
    const cases = this.caseCounts();
    const interventions = this.interventionCounts();

    return {
      generatedAt: this.clock.now(),
      cases,
      revenue: this.revenue(),
      interventions,
      timing: this.timing(),
      policy: this.policy(),
      actions: this.actionBreakdown(),
      diagnoses: this.diagnosisBreakdown(),
      decisionSources: this.decisionSources(),
      rates: {
        recoveryRate: safeRate(cases.recovered, interventions.casesWithIntervention),
        interventionSuccessRate: safeRate(interventions.succeeded, interventions.attempted),
        escalationRate: safeRate(cases.escalated, cases.total),
        policyBlockRate: safeRate(this.policy().blocked, this.policy().evaluations),
      },
    };
  }

  private caseCounts(): CaseCounts {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS n FROM recovery_cases GROUP BY state`)
      .all() as Row[];

    const by = new Map(rows.map((r) => [String(r.state), Number(r.n)]));
    const get = (state: RecoveryState): number => by.get(state) ?? 0;
    const total = [...by.values()].reduce((sum, n) => sum + n, 0);

    const terminal =
      get(RecoveryState.RECOVERED) +
      get(RecoveryState.FAILED) +
      get(RecoveryState.NOT_RECOVERABLE) +
      get(RecoveryState.ESCALATED) +
      get(RecoveryState.STOPPED);

    return {
      total,
      open: total - terminal,
      recovered: get(RecoveryState.RECOVERED),
      failed: get(RecoveryState.FAILED),
      notRecoverable: get(RecoveryState.NOT_RECOVERABLE),
      escalated: get(RecoveryState.ESCALATED),
      stopped: get(RecoveryState.STOPPED),
      blocked: get(RecoveryState.BLOCKED_BY_POLICY),
    };
  }

  private revenue(): RevenueTotals {
    const atRisk = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_paise),0) AS t FROM recovery_cases WHERE state NOT IN ${TERMINAL_SQL}`,
      )
      .get() as { t: number };

    // The single source of truth for recovered money. Deliberately keyed on the
    // dedicated column rather than on amount_paise, so only a case the outcome
    // tracker confirmed can contribute.
    const recovered = this.db
      .prepare(
        `SELECT COALESCE(SUM(recovered_amount_paise),0) AS t FROM recovery_cases WHERE state = 'RECOVERED'`,
      )
      .get() as { t: number };

    const unrecovered = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_paise),0) AS t FROM recovery_cases
          WHERE state IN ('FAILED','NOT_RECOVERABLE','STOPPED')`,
      )
      .get() as { t: number };

    return {
      atRiskPaise: Number(atRisk.t),
      recoveredPaise: Number(recovered.t),
      unrecoveredPaise: Number(unrecovered.t),
    };
  }

  private interventionCounts(): InterventionCounts {
    const placeholders = REAL_INTERVENTIONS.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM recovery_actions
          WHERE action IN (${placeholders}) GROUP BY status`,
      )
      .all(...REAL_INTERVENTIONS) as Row[];

    const by = new Map(rows.map((r) => [String(r.status), Number(r.n)]));
    const succeeded = by.get(ActionStatus.SUCCEEDED) ?? 0;
    const failed = by.get(ActionStatus.FAILED) ?? 0;

    const withIntervention = this.db
      .prepare(
        `SELECT COUNT(DISTINCT case_id) AS n FROM recovery_actions
          WHERE action IN (${placeholders}) AND status IN ('SUCCEEDED','FAILED')`,
      )
      .get(...REAL_INTERVENTIONS) as { n: number };

    return {
      attempted: succeeded + failed,
      succeeded,
      failed,
      skippedDuplicate: by.get(ActionStatus.SKIPPED_DUPLICATE) ?? 0,
      casesWithIntervention: Number(withIntervention.n),
    };
  }

  private timing(): RecoveryTiming {
    const rows = this.db
      .prepare(
        `SELECT opened_at, recovered_at FROM recovery_cases
          WHERE state = 'RECOVERED' AND recovered_at IS NOT NULL`,
      )
      .all() as Row[];

    const hours = rows.map((r) =>
      hoursBetween(fromIso(String(r.opened_at)), fromIso(String(r.recovered_at))),
    );

    return {
      averageHoursToRecovery: average(hours),
      medianHoursToRecovery: median(hours),
      fastestHours: hours.length > 0 ? Math.min(...hours) : null,
      slowestHours: hours.length > 0 ? Math.max(...hours) : null,
    };
  }

  private policy(): PolicyStats {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS evaluations,
           COALESCE(SUM(approved), 0) AS approved,
           COALESCE(SUM(CASE WHEN effective_action IS NOT NULL
                              AND effective_action <> original_action THEN 1 ELSE 0 END), 0) AS overridden
         FROM policy_evaluations`,
      )
      .get() as Row;

    const evaluations = Number(totals.evaluations);
    const approved = Number(totals.approved);

    const blocksByRule = (
      this.db
        .prepare(
          `SELECT rule_code, COUNT(*) AS n FROM policy_evaluations
            WHERE approved = 0 GROUP BY rule_code ORDER BY n DESC, rule_code ASC`,
        )
        .all() as Row[]
    ).map((r) => ({ ruleCode: String(r.rule_code), count: Number(r.n) }));

    return {
      evaluations,
      approved,
      blocked: evaluations - approved,
      overridden: Number(totals.overridden),
      blocksByRule,
    };
  }

  private actionBreakdown(): ActionBreakdown[] {
    const proposed = new Map(
      (
        this.db
          .prepare(`SELECT recommended_action AS a, COUNT(*) AS n FROM recovery_decisions GROUP BY a`)
          .all() as Row[]
      ).map((r) => [String(r.a), Number(r.n)]),
    );

    const executed = this.db
      .prepare(`SELECT action AS a, status, COUNT(*) AS n FROM recovery_actions GROUP BY a, status`)
      .all() as Row[];

    return Object.values(RecoveryAction).map((action) => {
      const forAction = executed.filter((r) => String(r.a) === action);
      const count = (status: string): number =>
        Number(forAction.find((r) => String(r.status) === status)?.n ?? 0);
      const succeeded = count(ActionStatus.SUCCEEDED);
      const failed = count(ActionStatus.FAILED);
      return {
        action,
        proposed: proposed.get(action) ?? 0,
        attempted: succeeded + failed,
        succeeded,
        failed,
      };
    });
  }

  private diagnosisBreakdown(): DiagnosisBreakdown[] {
    return (
      this.db
        .prepare(
          `SELECT diagnosis,
                  COUNT(*) AS cases,
                  COALESCE(SUM(CASE WHEN state = 'RECOVERED' THEN 1 ELSE 0 END), 0) AS recovered
             FROM recovery_cases
            WHERE diagnosis IS NOT NULL
            GROUP BY diagnosis
            ORDER BY cases DESC`,
        )
        .all() as Row[]
    ).map((r) => ({
      diagnosis: String(r.diagnosis),
      cases: Number(r.cases),
      recovered: Number(r.recovered),
    }));
  }

  private decisionSources(): DecisionSourceStat[] {
    return (
      this.db
        .prepare(
          `SELECT decision_source AS s, COUNT(*) AS n FROM recovery_decisions
            GROUP BY s ORDER BY n DESC`,
        )
        .all() as Row[]
    ).map((r) => ({ source: String(r.s), count: Number(r.n) }));
  }

  /** Confirmed recoveries bucketed by day, for a revenue-over-time chart. */
  recoveredByDay(): Array<{ day: string; cases: number; amountPaise: number }> {
    return (
      this.db
        .prepare(
          `SELECT substr(recovered_at, 1, 10) AS day,
                  COUNT(*) AS cases,
                  COALESCE(SUM(recovered_amount_paise), 0) AS amount
             FROM recovery_cases
            WHERE state = 'RECOVERED' AND recovered_at IS NOT NULL
            GROUP BY day ORDER BY day ASC`,
        )
        .all() as Row[]
    ).map((r) => ({
      day: String(r.day),
      cases: Number(r.cases),
      amountPaise: Number(r.amount),
    }));
  }
}
