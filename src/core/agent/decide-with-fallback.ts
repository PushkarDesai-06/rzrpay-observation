import type { RecoveryContext } from "@/core/context/recovery-context";
import type { RecoveryDecision } from "@/core/domain/types";
import { DecisionSource } from "@/core/domain/enums";
import { InvalidDecisionError } from "@/core/agent/decision-schema";
import { decideHeuristically } from "@/core/agent/heuristic-decider";
import type { AgentDecisionResult } from "@/core/agent/recovery-agent";

export interface AttemptContext {
  attempt: number;
  /** Schema violations from the previous attempt, for a targeted repair. */
  priorIssues: string[];
}

export type DecisionAttempt = (
  ctx: AttemptContext,
) => Promise<{ decision: RecoveryDecision; raw: unknown }>;

/**
 * The shared failure policy for every model-backed decider.
 *
 * Provider clients differ; how we handle a bad answer should not. One repair
 * attempt naming the exact schema violations, then the deterministic decider —
 * recorded as `heuristic_fallback`, never dressed up as a model decision.
 * Keeping this in one place is what stops the Anthropic and OpenAI-compatible
 * paths from drifting into two different safety stories.
 */
export async function decideWithFallback(params: {
  context: RecoveryContext;
  model: string | null;
  attempt: DecisionAttempt;
  isRetryable: (error: unknown) => boolean;
  describeError: (error: unknown, attempt: number) => string;
  maxAttempts?: number;
}): Promise<AgentDecisionResult> {
  const startedAt = Date.now();
  const maxAttempts = params.maxAttempts ?? 2;
  const warnings: string[] = [];
  let priorIssues: string[] = [];
  let lastRaw: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const { decision, raw } = await params.attempt({ attempt, priorIssues });
      lastRaw = raw;
      return {
        decision,
        source: DecisionSource.LLM,
        model: params.model,
        latencyMs: Date.now() - startedAt,
        raw,
        warnings,
      };
    } catch (error) {
      warnings.push(params.describeError(error, attempt));
      priorIssues = error instanceof InvalidDecisionError ? error.issues : [];
      if (error instanceof InvalidDecisionError) lastRaw = error.raw;
      if (!params.isRetryable(error)) break;
    }
  }

  return {
    decision: decideHeuristically(params.context),
    source: DecisionSource.HEURISTIC_FALLBACK,
    model: null,
    latencyMs: Date.now() - startedAt,
    raw: lastRaw,
    warnings: [
      ...warnings,
      "Fell back to the deterministic decider; this is not a model decision",
    ],
  };
}
