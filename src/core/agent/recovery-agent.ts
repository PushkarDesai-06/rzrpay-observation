import type { RecoveryContext } from "@/core/context/recovery-context";
import type { RecoveryDecision } from "@/core/domain/types";
import type { DecisionSource } from "@/core/domain/enums";
import { DecisionSource as Source } from "@/core/domain/enums";
import { decideHeuristically } from "@/core/agent/heuristic-decider";

export interface AgentDecisionResult {
  decision: RecoveryDecision;
  /** Which decider actually produced this. Persisted and shown in the UI. */
  source: DecisionSource;
  model: string | null;
  latencyMs: number;
  raw: unknown;
  /** Non-fatal problems worth recording, e.g. a schema repair or a fallback. */
  warnings: string[];
}

export interface RecoveryAgent {
  readonly name: string;
  decide(context: RecoveryContext): Promise<AgentDecisionResult>;
}

/**
 * Deterministic decider used as the fallback everywhere, and as the primary
 * decider when no model credentials are configured.
 */
export class HeuristicRecoveryAgent implements RecoveryAgent {
  readonly name = "heuristic";

  decide(context: RecoveryContext): Promise<AgentDecisionResult> {
    const startedAt = Date.now();
    const decision = decideHeuristically(context);
    return Promise.resolve({
      decision,
      source: Source.HEURISTIC_FALLBACK,
      model: null,
      latencyMs: Date.now() - startedAt,
      raw: null,
      warnings: [],
    });
  }
}

/** Returns canned decisions. Used by tests so suites never touch the network. */
export class FixtureRecoveryAgent implements RecoveryAgent {
  readonly name = "fixture";
  private calls = 0;

  constructor(private readonly decisions: RecoveryDecision[]) {
    if (decisions.length === 0) throw new Error("FixtureRecoveryAgent needs at least one decision");
  }

  get callCount(): number {
    return this.calls;
  }

  decide(_context: RecoveryContext): Promise<AgentDecisionResult> {
    const index = Math.min(this.calls, this.decisions.length - 1);
    this.calls += 1;
    return Promise.resolve({
      decision: this.decisions[index]!,
      source: Source.FIXTURE,
      model: null,
      latencyMs: 0,
      raw: null,
      warnings: [],
    });
  }
}
