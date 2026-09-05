import type { Paise } from "@/core/domain/money";
import { RecoveryState } from "@/core/domain/enums";
import { safeRate } from "@/core/metrics/metrics";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import type { ArmResult, CaseOutcome } from "@/evaluation/harness";

/**
 * Turns arm results into the numbers a comparison may honestly report.
 *
 * The one trap this file exists to avoid: the recovery rate on a metrics
 * snapshot is conditioned on cases where an intervention was executed, which is
 * the right operational measure but the wrong comparison. Arms attempt
 * different numbers of interventions, so that denominator differs between them
 * — a strategy that intervenes on two easy cases and ignores the rest would
 * post the best rate while recovering the least money. Cross-arm comparison
 * uses `recoveryRateOverBook`, whose denominator is the identical dataset every
 * arm was given. Both are reported, each labelled with its denominator.
 */

export interface ArmSummary {
  arm: string;
  decider: string;

  casesInBook: number;
  atRiskPaise: Paise;

  recoveredCases: number;
  recoveredPaise: Paise;

  /** Recovered ÷ every case in the dataset. Comparable across arms. */
  recoveryRateOverBook: number;
  /** Recovered ÷ cases where an intervention ran. Not comparable across arms. */
  recoveryRateOverAttempts: number;

  interventionsAttempted: number;
  interventionsSucceeded: number;
  customerMessages: number;
  retries: number;

  escalated: number;
  stopped: number;
  failed: number;
  notRecoverable: number;
  /** Proposals refused outright. Excludes ESCALATE/STOP diversions. */
  policyBlocks: number;
  /** Proposals the policy engine replaced with ESCALATE or STOP. */
  policyDiversions: number;

  /**
   * Money recovered per message sent to a customer.
   *
   * The cost side of recovery. Two strategies that recover similar amounts are
   * not equivalent if one of them mails every customer to do it.
   */
  paisePerCustomerMessage: number | null;

  averageHoursToRecovery: number | null;
  medianHoursToRecovery: number | null;

  /** Set when the run hit a limit that makes its numbers unsafe to compare. */
  caveats: string[];
}

const CUSTOMER_CONTACT = new Set(["SEND_REMINDER", "CREATE_PAYMENT_LINK"]);

export function summariseArm(result: ArmResult, atRiskPaise: Paise): ArmSummary {
  const snap = result.snapshot;
  const casesInBook = result.outcomes.length;

  const recoveredCases = result.outcomes.filter((o) => o.recovered).length;
  const recoveredPaise = result.outcomes.reduce((sum, o) => sum + o.recoveredAmountPaise, 0);

  const executedActions = result.outcomes.flatMap((o) => o.actions);
  const customerMessages = executedActions.filter((a) => CUSTOMER_CONTACT.has(a)).length;

  const caveats: string[] = [];
  if (result.hitRoundLimit) {
    caveats.push(
      `Stopped after ${result.rounds} rounds with ${result.openCasesAtEnd} case(s) still open; totals are incomplete`,
    );
  }
  if (result.globalCapBlocks > 0) {
    caveats.push(
      `${result.globalCapBlocks} action(s) blocked by the system-wide daily cap — a batch-size artefact, not a strategy difference`,
    );
  }

  return {
    arm: result.arm,
    decider: result.decider,

    casesInBook,
    atRiskPaise,

    recoveredCases,
    recoveredPaise,

    recoveryRateOverBook: safeRate(recoveredCases, casesInBook),
    recoveryRateOverAttempts: snap.rates.recoveryRate,

    interventionsAttempted: snap.interventions.attempted,
    interventionsSucceeded: snap.interventions.succeeded,
    customerMessages,
    retries: executedActions.filter((a) => a === "RETRY_PAYMENT").length,

    escalated: snap.cases.escalated,
    stopped: snap.cases.stopped,
    failed: snap.cases.failed,
    notRecoverable: snap.cases.notRecoverable,
    policyBlocks: result.genuineBlocks,
    policyDiversions: result.diversions,

    paisePerCustomerMessage: customerMessages > 0 ? recoveredPaise / customerMessages : null,

    averageHoursToRecovery: snap.timing.averageHoursToRecovery,
    medianHoursToRecovery: snap.timing.medianHoursToRecovery,

    caveats,
  };
}

export interface Comparison {
  reference: ArmSummary;
  arms: ArmSummary[];
  /** Money recovered above the reference arm, per arm. */
  upliftPaise: Map<string, Paise>;
  upliftCases: Map<string, number>;
}

export function compare(summaries: readonly ArmSummary[], referenceArm: string): Comparison {
  const reference = summaries.find((s) => s.arm === referenceArm);
  if (!reference) throw new Error(`No arm named ${referenceArm} in this comparison`);

  const upliftPaise = new Map<string, Paise>();
  const upliftCases = new Map<string, number>();
  for (const summary of summaries) {
    upliftPaise.set(summary.arm, summary.recoveredPaise - reference.recoveredPaise);
    upliftCases.set(summary.arm, summary.recoveredCases - reference.recoveredCases);
  }

  return { reference, arms: [...summaries], upliftPaise, upliftCases };
}

/**
 * The demonstration scenarios, recognised from what actually happened.
 *
 * Nothing here steers a case towards a scenario; this reads the finished record
 * and reports which shapes the run produced. A scenario with zero cases is a
 * real gap in the demonstration, not something to paper over.
 */
export const Scenario = {
  RECOVERED_BY_RETRY: "Recovered by retry",
  RECOVERED_BY_LINK: "Recovered by payment link",
  NO_CUSTOMER_RESPONSE: "Customer never responded",
  ESCALATED_HIGH_VALUE: "Escalated — high value",
  ESCALATED_LOW_CONFIDENCE: "Escalated — low confidence",
  ESCALATED_BY_JUDGEMENT: "Escalated — decider asked for a human",
  POLICY_BLOCKED: "Action blocked by policy",
  ATTEMPTS_EXHAUSTED: "Attempted, never recovered",
  NOT_PURSUED: "Closed without an intervention",
} as const;
export type Scenario = (typeof Scenario)[keyof typeof Scenario];

/**
 * Every scenario a case demonstrates. A case may demonstrate more than one —
 * a blocked proposal followed by an escalation is both.
 */
export function scenariosFor(
  outcome: CaseOutcome,
  escalationThresholdPaise: Paise = DEFAULT_POLICY.escalationAmountThresholdPaise,
): Scenario[] {
  const found: Scenario[] = [];
  const intervened = outcome.actions.some(
    (a) => a === "RETRY_PAYMENT" || CUSTOMER_CONTACT.has(a),
  );

  if (outcome.recovered) {
    // Which intervention landed is settled by the outcome tracker, which
    // confirms a link payment ahead of anything else that ran on the case.
    const hasLink = outcome.actions.includes("CREATE_PAYMENT_LINK");
    if (hasLink) found.push(Scenario.RECOVERED_BY_LINK);
    else if (outcome.actions.includes("RETRY_PAYMENT")) found.push(Scenario.RECOVERED_BY_RETRY);
  }

  if (outcome.policyBlocks > 0) found.push(Scenario.POLICY_BLOCKED);

  if (outcome.finalState === RecoveryState.ESCALATED) {
    // The amount decides first. Above the threshold a human was always going to
    // review it, whether the policy diverted the case or the decider asked.
    if (outcome.amountPaise >= escalationThresholdPaise) {
      found.push(Scenario.ESCALATED_HIGH_VALUE);
    } else if (
      outcome.terminalRule === "LOW_CONFIDENCE_ESCALATION" ||
      outcome.terminalRule === "FINANCIAL_ACTION_CONFIDENCE"
    ) {
      found.push(Scenario.ESCALATED_LOW_CONFIDENCE);
    } else {
      found.push(Scenario.ESCALATED_BY_JUDGEMENT);
    }
  }

  if (!outcome.recovered && outcome.finalState !== RecoveryState.ESCALATED) {
    if (!intervened) {
      found.push(Scenario.NOT_PURSUED);
    } else if (outcome.actions.some((a) => CUSTOMER_CONTACT.has(a))) {
      // The customer was reached and the money never arrived.
      found.push(Scenario.NO_CUSTOMER_RESPONSE);
    } else {
      found.push(Scenario.ATTEMPTS_EXHAUSTED);
    }
  }

  return found;
}

export function scenarioCoverage(
  outcomes: readonly CaseOutcome[],
  escalationThresholdPaise: Paise = DEFAULT_POLICY.escalationAmountThresholdPaise,
): Array<{ scenario: Scenario; cases: number }> {
  const counts = new Map<Scenario, number>();
  for (const scenario of Object.values(Scenario)) counts.set(scenario, 0);
  for (const outcome of outcomes) {
    for (const scenario of scenariosFor(outcome, escalationThresholdPaise)) {
      counts.set(scenario, (counts.get(scenario) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([scenario, cases]) => ({ scenario, cases }));
}
