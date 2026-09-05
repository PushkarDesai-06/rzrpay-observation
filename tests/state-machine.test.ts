import { describe, it, expect } from "vitest";
import {
  TRANSITIONS,
  canTransition,
  assertTransition,
  allowedTransitions,
  InvalidTransitionError,
} from "@/core/state/state-machine";
import { RecoveryState, TERMINAL_STATES, isTerminal } from "@/core/domain/enums";

const ALL_STATES = Object.values(RecoveryState);

describe("transition table integrity", () => {
  it("defines an entry for every declared state", () => {
    for (const state of ALL_STATES) {
      expect(TRANSITIONS[state], `missing entry for ${state}`).toBeDefined();
    }
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it("only ever targets declared states", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL_STATES, `${from} -> ${to} targets an unknown state`).toContain(to);
      }
    }
  });

  it("never lists a self-transition", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(targets, `${from} transitions to itself`).not.toContain(from);
    }
  });

  it("reaches every state from DETECTED", () => {
    const seen = new Set<string>([RecoveryState.DETECTED]);
    const queue: string[] = [RecoveryState.DETECTED];
    while (queue.length > 0) {
      const current = queue.shift() as RecoveryState;
      for (const next of TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const state of ALL_STATES) {
      expect(seen.has(state), `${state} is unreachable from DETECTED`).toBe(true);
    }
  });
});

describe("terminal states", () => {
  it("has no outgoing transitions from any terminal state", () => {
    for (const state of TERMINAL_STATES) {
      expect(allowedTransitions(state), `${state} should be a dead end`).toEqual([]);
    }
  });

  it("classifies exactly the intended states as terminal", () => {
    const terminalByTable = ALL_STATES.filter((s) => TRANSITIONS[s].length === 0);
    expect(terminalByTable.sort()).toEqual([...TERMINAL_STATES].sort());
    expect(isTerminal(RecoveryState.RECOVERED)).toBe(true);
    expect(isTerminal(RecoveryState.WAITING_FOR_OUTCOME)).toBe(false);
  });

  it("refuses to reopen a recovered case", () => {
    expect(canTransition(RecoveryState.RECOVERED, RecoveryState.ANALYZING)).toBe(false);
    expect(() =>
      assertTransition(RecoveryState.RECOVERED, RecoveryState.ANALYZING),
    ).toThrow(InvalidTransitionError);
  });

  it("refuses to reopen any terminal case, to any state", () => {
    for (const from of TERMINAL_STATES) {
      for (const to of ALL_STATES) {
        expect(canTransition(from, to), `${from} -> ${to} must be illegal`).toBe(false);
      }
    }
  });
});

describe("the happy path from the spec", () => {
  it("permits DETECTED -> ... -> RECOVERED step by step", () => {
    const path = [
      RecoveryState.DETECTED,
      RecoveryState.ANALYZING,
      RecoveryState.RECOVERY_CANDIDATE,
      RecoveryState.ACTION_PLANNED,
      RecoveryState.POLICY_VALIDATED,
      RecoveryState.ACTION_EXECUTING,
      RecoveryState.WAITING_FOR_OUTCOME,
      RecoveryState.RECOVERED,
    ] as const;

    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it("forbids skipping straight from DETECTED to RECOVERED", () => {
    expect(() =>
      assertTransition(RecoveryState.DETECTED, RecoveryState.RECOVERED),
    ).toThrow(InvalidTransitionError);
  });

  it("forbids executing an action that was never policy-validated", () => {
    expect(
      canTransition(RecoveryState.ACTION_PLANNED, RecoveryState.ACTION_EXECUTING),
    ).toBe(false);
  });

  it("forbids reaching RECOVERED from anywhere except WAITING_FOR_OUTCOME", () => {
    const sources = ALL_STATES.filter((s) => canTransition(s, RecoveryState.RECOVERED));
    expect(sources).toEqual([RecoveryState.WAITING_FOR_OUTCOME]);
  });
});

describe("policy-blocked cases", () => {
  it("can wait or stop, and nothing else", () => {
    expect(allowedTransitions(RecoveryState.BLOCKED_BY_POLICY)).toEqual([
      RecoveryState.ANALYZING,
      RecoveryState.STOPPED,
    ]);
  });

  it("cannot be marked recovered directly", () => {
    expect(
      canTransition(RecoveryState.BLOCKED_BY_POLICY, RecoveryState.RECOVERED),
    ).toBe(false);
  });
});

describe("error reporting", () => {
  it("names both states and the legal alternatives", () => {
    try {
      assertTransition(RecoveryState.DETECTED, RecoveryState.RECOVERED);
      expect.unreachable("should have thrown");
    } catch (error) {
      const err = error as InvalidTransitionError;
      expect(err.from).toBe(RecoveryState.DETECTED);
      expect(err.to).toBe(RecoveryState.RECOVERED);
      expect(err.message).toContain("ANALYZING");
    }
  });

  it("says a terminal state is terminal", () => {
    try {
      assertTransition(RecoveryState.STOPPED, RecoveryState.ANALYZING);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("terminal");
    }
  });
});

describe("a failed external call", () => {
  it("returns the case to analysis rather than re-running a stale plan", () => {
    expect(canTransition(RecoveryState.ACTION_EXECUTING, RecoveryState.ANALYZING)).toBe(true);
    expect(canTransition(RecoveryState.ACTION_EXECUTING, RecoveryState.ACTION_PLANNED)).toBe(false);
  });

  it("can give up explicitly when no attempts remain", () => {
    expect(canTransition(RecoveryState.ACTION_EXECUTING, RecoveryState.FAILED)).toBe(true);
  });

  it("still cannot reach RECOVERED without observing an outcome", () => {
    expect(canTransition(RecoveryState.ACTION_EXECUTING, RecoveryState.RECOVERED)).toBe(false);
  });
});
