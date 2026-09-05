import { FailureCode } from "@/core/domain/enums";

/**
 * Normalise a provider's free-text failure reason onto the closed FailureCode set.
 *
 * This is deliberately deterministic string matching, not an LLM call. The spec
 * is explicit that the detection layer should not contain AI reasoning where
 * rules suffice — and no policy rule should ever have to parse provider prose.
 * Genuinely ambiguous text maps to UNKNOWN, which is exactly the kind of case
 * the agent is useful for.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, FailureCode]> = [
  [/insufficient[\s_-]*(funds|balance)|low[\s_-]*balance|not[\s_-]*enough/i, FailureCode.INSUFFICIENT_FUNDS],
  [/expired|expiry|exp[\s_-]*date/i, FailureCode.CARD_EXPIRED],
  [/cvv|cvc|security[\s_-]*code/i, FailureCode.INCORRECT_CVV],
  [/3ds|otp|authenticat|verif(y|ication)[\s_-]*fail/i, FailureCode.AUTHENTICATION_FAILED],
  [/issuer|bank[\s_-]*(down|unavailable|declin)|acquirer/i, FailureCode.ISSUER_UNAVAILABLE],
  [/timeout|timed[\s_-]*out|gateway[\s_-]*error/i, FailureCode.GATEWAY_TIMEOUT],
  [/network|connection|unreachable/i, FailureCode.NETWORK_ERROR],
  [/cancel|abandon|user[\s_-]*dropped/i, FailureCode.PAYMENT_CANCELLED],
  [/limit[\s_-]*exceeded|exceeds[\s_-]*limit|per[\s_-]*transaction[\s_-]*limit/i, FailureCode.LIMIT_EXCEEDED],
  [/declin|do[\s_-]*not[\s_-]*honou?r|refused/i, FailureCode.CARD_DECLINED],
];

export function normaliseFailureReason(raw: string | null | undefined): FailureCode {
  if (!raw) return FailureCode.UNKNOWN;

  // An exact provider code wins over prose matching.
  const upper = raw.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (upper in FailureCode) return FailureCode[upper as keyof typeof FailureCode];

  for (const [pattern, code] of PATTERNS) {
    if (pattern.test(raw)) return code;
  }
  return FailureCode.UNKNOWN;
}
