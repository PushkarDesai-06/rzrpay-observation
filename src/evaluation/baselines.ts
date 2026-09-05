import {
  Diagnosis,
  DecisionSource,
  Recoverability,
  RecoveryAction,
} from "@/core/domain/enums";
import type { RecoveryContext } from "@/core/context/recovery-context";
import type { RecoveryDecision } from "@/core/domain/types";
import type { AgentDecisionResult, RecoveryAgent } from "@/core/agent/recovery-agent";

/**
 * Fixed strategies to compare the agent against.
 *
 * Each one is a `RecoveryAgent`, so it runs on exactly the same rails as the
 * agent: the same policy engine, the same executor, the same outcome tracker,
 * the same provider draws. The only thing that varies between arms is which
 * action gets proposed. That is what makes the comparison attributable to the
 * strategy rather than to differences in the machinery around it.
 *
 * Every decision they emit is recorded with source `baseline`, so a baseline
 * run can never be read back as though a model produced it.
 *
 * Two deliberate properties of these strategies:
 *
 *   They state high confidence. A fixed rule has no notion of uncertainty, and
 *   a rule that declared low confidence would be escalated by policy rule 7 and
 *   would stop being the baseline it claims to be.
 *
 *   They diagnose nothing. `UNKNOWN` is the honest label for a strategy that
 *   never looks at why the payment failed — which is precisely the capability
 *   under test.
 */

const FIXED_CONFIDENCE = 0.9;

function decision(
  action: RecoveryAction,
  summary: string,
  recoverability: Recoverability = Recoverability.MEDIUM,
): RecoveryDecision {
  return {
    diagnosis: Diagnosis.UNKNOWN,
    recoverability,
    confidence: FIXED_CONFIDENCE,
    recommendedAction: action,
    reasoningSummary: summary,
    // A fixed rule makes no estimate of what it will recover. Reporting the
    // full amount would be a claim, not a forecast, so it is left at zero.
    expectedValuePaise: 0,
  };
}

function result(decided: RecoveryDecision, name: string): AgentDecisionResult {
  return {
    decision: decided,
    source: DecisionSource.BASELINE,
    model: null,
    latencyMs: 0,
    raw: { baseline: name },
    warnings: [],
  };
}

/**
 * Do nothing.
 *
 * The floor. It exists to answer "what if the merchant had no recovery system
 * at all", and it recovers nothing by construction: this simulation models no
 * unprompted self-service payment, so any recovery in another arm is the result
 * of an intervention that arm actually made. Read the zero as a definition of
 * the baseline, not as a measurement of customer behaviour.
 */
export class NoInterventionBaseline implements RecoveryAgent {
  readonly name = "baseline:no-intervention";

  decide(_context: RecoveryContext): Promise<AgentDecisionResult> {
    return Promise.resolve(
      result(
        decision(
          RecoveryAction.STOP,
          "Fixed baseline: no recovery is attempted for any failed payment.",
          Recoverability.LOW,
        ),
        this.name,
      ),
    );
  }
}

/**
 * Retry every failed payment exactly once, then give up.
 *
 * The common production rule, and the honest thing to beat. It ignores the
 * failure reason entirely, so it spends its one attempt on expired cards and
 * failed 3DS challenges where a retry of the same instrument cannot work — and
 * the policy engine blocks those, which is visible in the report as a block
 * count rather than as a wasted charge.
 */
export class AlwaysRetryOnceBaseline implements RecoveryAgent {
  readonly name = "baseline:always-retry-once";

  decide(context: RecoveryContext): Promise<AgentDecisionResult> {
    // Keyed on the evaluation cycle, not on executed actions: a retry that was
    // blocked still consumed this strategy's single attempt. Without that, a
    // hard decline would be re-proposed every cycle for the whole window.
    const first = context.cycle <= 1;
    return Promise.resolve(
      result(
        decision(
          first ? RecoveryAction.RETRY_PAYMENT : RecoveryAction.STOP,
          first
            ? "Fixed baseline: retry every failed payment once, regardless of why it failed."
            : "Fixed baseline: the single retry has been used; recovery ends here.",
        ),
        this.name,
      ),
    );
  }
}

/**
 * Send every customer a payment link, then wait out the window.
 *
 * The other single-action rule worth measuring. It never retries, so it pays
 * the customer-effort cost even on failures that would have cleared by
 * themselves — and it waits rather than stopping while a link is live, because
 * closing a case with an unpaid link outstanding would discard recoveries the
 * strategy actually earned.
 */
export class AlwaysPaymentLinkBaseline implements RecoveryAgent {
  readonly name = "baseline:always-payment-link";

  decide(context: RecoveryContext): Promise<AgentDecisionResult> {
    const hasLink = context.history.paymentLinksCreated > 0;
    const windowOpen = context.budget.hoursLeftInRecoveryWindow > 0;

    let action: RecoveryAction;
    let summary: string;
    if (!hasLink) {
      action = RecoveryAction.CREATE_PAYMENT_LINK;
      summary = "Fixed baseline: send every customer a payment link, regardless of why the payment failed.";
    } else if (windowOpen) {
      action = RecoveryAction.WAIT;
      summary = "Fixed baseline: a link is outstanding; wait for the customer rather than acting again.";
    } else {
      action = RecoveryAction.STOP;
      summary = "Fixed baseline: the recovery window has closed with the link unpaid.";
    }

    return Promise.resolve(result(decision(action, summary), this.name));
  }
}
