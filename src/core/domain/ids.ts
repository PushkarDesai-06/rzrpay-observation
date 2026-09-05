import { randomUUID } from "node:crypto";

/**
 * Prefixed, sortable-ish identifiers. The prefix makes an id self-describing
 * in logs and in the audit trail, which matters when tracing a case by hand.
 */
function id(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export const newCaseId = (): string => id("case");
export const newEventId = (): string => id("evt");
export const newDecisionId = (): string => id("dec");
export const newPolicyEvaluationId = (): string => id("pol");
export const newActionId = (): string => id("act");
export const newTransitionId = (): string => id("tr");
export const newAuditId = (): string => id("aud");
export const newMessageId = (): string => id("msg");
export const newCustomerId = (): string => id("cust");
export const newPaymentId = (): string => id("pay");

/**
 * Idempotency key for an action.
 *
 * Deterministic in (case, action, cycle): re-running the same evaluation cycle
 * produces the same key, and the UNIQUE constraint turns the second execution
 * into a no-op instead of a second charge or a second email.
 */
export function actionIdempotencyKey(
  caseId: string,
  action: string,
  cycle: number,
): string {
  return `${caseId}:${action}:${cycle}`;
}

/** Idempotency key for an inbound event, derived from provider identifiers. */
export function eventIdempotencyKey(
  provider: string,
  externalId: string,
  type: string,
): string {
  return `${provider}:${externalId}:${type}`;
}
