import type { Paise } from "@/core/domain/money";

/**
 * Derived measures over recovery outcomes.
 *
 * Every number here is computed from stored rows at query time — nothing is
 * accumulated into a running total as work happens. That is deliberate: a
 * stored counter can be incremented twice, and the one thing this system must
 * never do is count recovered revenue more than once.
 */

export interface CaseCounts {
  total: number;
  open: number;
  recovered: number;
  failed: number;
  notRecoverable: number;
  escalated: number;
  stopped: number;
  blocked: number;
}

export interface RevenueTotals {
  atRiskPaise: Paise;
  recoveredPaise: Paise;
  /** Amounts on cases that closed without recovery. Not "loss caused by us". */
  unrecoveredPaise: Paise;
}

export interface InterventionCounts {
  /** Executed interventions that contacted a provider or customer. WAIT excluded. */
  attempted: number;
  succeeded: number;
  failed: number;
  skippedDuplicate: number;
  /** Cases where at least one real intervention was executed. */
  casesWithIntervention: number;
}

export interface ActionBreakdown {
  action: string;
  proposed: number;
  attempted: number;
  succeeded: number;
  failed: number;
}

export interface DiagnosisBreakdown {
  diagnosis: string;
  cases: number;
  recovered: number;
}

export interface PolicyStats {
  evaluations: number;
  approved: number;
  blocked: number;
  overridden: number;
  blocksByRule: Array<{ ruleCode: string; count: number }>;
}

export interface DecisionSourceStat {
  source: string;
  count: number;
}

export interface RecoveryTiming {
  averageHoursToRecovery: number | null;
  medianHoursToRecovery: number | null;
  fastestHours: number | null;
  slowestHours: number | null;
}

export interface MetricsSnapshot {
  generatedAt: Date;
  cases: CaseCounts;
  revenue: RevenueTotals;
  interventions: InterventionCounts;
  timing: RecoveryTiming;
  policy: PolicyStats;
  actions: ActionBreakdown[];
  diagnoses: DiagnosisBreakdown[];
  decisionSources: DecisionSourceStat[];
  rates: {
    /** Recovered cases ÷ cases where an intervention was actually executed. */
    recoveryRate: number;
    /** Successful interventions ÷ interventions executed. */
    interventionSuccessRate: number;
    escalationRate: number;
    policyBlockRate: number;
  };
}

/**
 * How each headline number is derived, in words.
 *
 * Carried alongside the numbers so a reader can check the definition without
 * reading the SQL — particularly the two that are easy to inflate.
 */
export const METRIC_DEFINITIONS: Readonly<Record<string, string>> = Object.freeze({
  revenueAtRisk:
    "Sum of amounts on cases still inside an active recovery workflow. Falls to zero for a case the moment it reaches any terminal state.",
  moneyRecovered:
    "Sum of amounts on cases in state RECOVERED. Written once, by the outcome tracker, only after the provider confirmed a capture. Payment links created, retries attempted and messages sent contribute nothing.",
  recoveryRate:
    "Recovered cases ÷ cases where at least one intervention was actually executed. Cases that were escalated or stopped before any intervention are excluded from the denominator, since nothing was attempted on them.",
  interventionSuccessRate:
    "Successful interventions ÷ interventions executed. Measures action reliability, not revenue — a delivered payment link counts as a success here even if the customer never paid.",
  averageTimeToRecovery:
    "Mean hours between case opening and confirmed payment, over recovered cases only.",
  policyBlocked:
    "Proposed actions the policy engine refused. Recorded per rule, so the reason is queryable rather than narrative.",
  escalations: "Cases handed to a human and closed in state ESCALATED.",
});

/** Division that reports 0 rather than NaN for an empty denominator. */
export function safeRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
