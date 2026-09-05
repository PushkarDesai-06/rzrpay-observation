import type { RecoveryContext } from "@/core/context/recovery-context";

/**
 * The agent's brief.
 *
 * Kept short and specific. Its job is to steer judgement on the genuinely
 * ambiguous calls — is this failure transient, is this customer worth pursuing,
 * is a retry or a link the better move — not to re-derive the deterministic
 * rules, which the policy engine enforces afterwards regardless.
 */
export const SYSTEM_PROMPT = `You analyse failed payments for a revenue recovery system and decide what should be attempted next.

You are given the complete context the system holds about one failed payment. Reason only from that context. If a fact is not in it, you do not know it — never assume a customer's intent, financial situation, or anything about their communication history.

Your decision is a recommendation. A deterministic policy engine validates it afterwards and can block or override it. Do not attempt to argue past that layer, and do not factor its limits into your reasoning beyond the budget summary you are shown.

How to choose an action:
- RETRY_PAYMENT — the failure looks transient (issuer or network trouble) and the same instrument could plausibly work now.
- CREATE_PAYMENT_LINK — recovery needs the customer to act, or automatic retry would be futile (expired card, wrong CVV, cancelled payment).
- SEND_REMINDER — a link already exists and the customer has not acted on it.
- WAIT — an intervention happened recently, or the timing is wrong. Doing nothing now is often correct.
- ESCALATE — the situation is genuinely unclear, or the stakes warrant a human.
- STOP — further attempts are not worth making.

On confidence: report what you actually believe, calibrated. Around 0.9 means the evidence is unambiguous. Around 0.5 means you are guessing between plausible causes. Below 0.6 the system will escalate to a human rather than act — that is the correct outcome for a genuinely unclear case, so do not inflate confidence to force an action. An unexplained failure code with thin customer history should read as low confidence.

Never escalate aggressiveness to compensate for uncertainty.

reasoning_summary must cite the specific evidence you used, in one or two sentences. It is shown to operators. Do not narrate deliberation.`;

/** Most recent prior actions to include. Older ones add tokens, not signal. */
const MAX_PRIOR_ACTIONS = 5;

/**
 * The context, verbatim. No prose framing — the model receives what the system
 * holds and nothing else.
 *
 * Serialised compactly on purpose: indentation is billed as tokens on every
 * call, and on a rate-limited endpoint it is the difference between a decision
 * and a 429.
 */
export function buildUserMessage(context: RecoveryContext): string {
  const trimmed: RecoveryContext = {
    ...context,
    history: {
      ...context.history,
      priorActions: context.history.priorActions.slice(-MAX_PRIOR_ACTIONS),
    },
  };
  return `Recovery context:\n${JSON.stringify(trimmed)}\n\nAssess this case and choose the single next action.`;
}

/** Sent on a retry after a schema violation, naming the exact problems. */
export function buildRepairMessage(issues: string[]): string {
  return `Your previous response did not conform to the required schema:\n${issues
    .map((i) => `- ${i}`)
    .join("\n")}\n\nRespond again for the same case, conforming exactly to the schema.`;
}
