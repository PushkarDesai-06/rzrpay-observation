import { RecoveryState, TERMINAL_STATES, isTerminal } from "@/core/domain/enums";

/**
 * The recovery case lifecycle, as an explicit transition table.
 *
 * This table is the only authority on what may follow what. Any move not
 * listed here throws; there is no code path that writes a case state without
 * going through `assertTransition`. Terminal states have no outgoing edges at
 * all, which is what makes "recovered" a claim that cannot later be walked
 * back or re-counted.
 */
export const TRANSITIONS: Readonly<Record<RecoveryState, readonly RecoveryState[]>> =
  Object.freeze({
    [RecoveryState.DETECTED]: [RecoveryState.ANALYZING],

    [RecoveryState.ANALYZING]: [
      RecoveryState.RECOVERY_CANDIDATE,
      RecoveryState.NOT_RECOVERABLE,
      RecoveryState.ESCALATED,
      RecoveryState.FAILED,
    ],

    [RecoveryState.RECOVERY_CANDIDATE]: [RecoveryState.ACTION_PLANNED],

    [RecoveryState.ACTION_PLANNED]: [
      RecoveryState.POLICY_VALIDATED,
      RecoveryState.BLOCKED_BY_POLICY,
      RecoveryState.ESCALATED,
      RecoveryState.STOPPED,
    ],

    [RecoveryState.POLICY_VALIDATED]: [RecoveryState.ACTION_EXECUTING],

    [RecoveryState.ACTION_EXECUTING]: [
      RecoveryState.WAITING_FOR_OUTCOME,
      // The external call failed. Re-analyse rather than re-running a stale
      // plan: the failure itself is new evidence the agent should weigh.
      RecoveryState.ANALYZING,
      RecoveryState.FAILED,
    ],

    [RecoveryState.WAITING_FOR_OUTCOME]: [
      RecoveryState.RECOVERED,
      // Re-evaluate on the next tick while the recovery window is still open.
      RecoveryState.ANALYZING,
      RecoveryState.STOPPED,
      RecoveryState.FAILED,
      RecoveryState.ESCALATED,
    ],

    /**
     * A holding state, not a terminal one. The spec lists it among the
     * alternative terminal states, but Case 5 requires a blocked case to
     * "wait or stop" — so it keeps exactly those two exits and no others.
     */
    [RecoveryState.BLOCKED_BY_POLICY]: [
      RecoveryState.ANALYZING,
      RecoveryState.STOPPED,
    ],

    // Terminal. No outgoing transitions, deliberately.
    [RecoveryState.RECOVERED]: [],
    [RecoveryState.FAILED]: [],
    [RecoveryState.NOT_RECOVERABLE]: [],
    [RecoveryState.ESCALATED]: [],
    [RecoveryState.STOPPED]: [],
  });

export class InvalidTransitionError extends Error {
  readonly from: RecoveryState;
  readonly to: RecoveryState;

  constructor(from: RecoveryState, to: RecoveryState) {
    const allowed = TRANSITIONS[from];
    const detail = allowed.length === 0
      ? `${from} is terminal and has no outgoing transitions`
      : `allowed from ${from}: ${allowed.join(", ")}`;
    super(`Illegal recovery state transition ${from} -> ${to} (${detail})`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: RecoveryState, to: RecoveryState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws unless the move is in the table. Every state write goes through this. */
export function assertTransition(from: RecoveryState, to: RecoveryState): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function allowedTransitions(from: RecoveryState): readonly RecoveryState[] {
  return TRANSITIONS[from];
}

export { TERMINAL_STATES, isTerminal };
