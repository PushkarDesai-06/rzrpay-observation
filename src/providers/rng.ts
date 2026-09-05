/**
 * Deterministic, seeded pseudo-randomness.
 *
 * Every simulated outcome is a pure function of (seed, key), so a whole batch
 * evaluation replays identically. That is what lets the baseline comparison be
 * honest: the agent and the rule-based baseline face the same coin flips, not
 * separately drawn luck.
 */

function hashKey(seed: number, key: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, adequate for simulation. */
function mulberry32(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable draw in [0, 1) for this key. Same key, same seed, same value. */
export function draw(seed: number, key: string): number {
  return mulberry32(hashKey(seed, key))();
}

/** True with probability `p`, deterministically for this key. */
export function chance(seed: number, key: string, p: number): boolean {
  return draw(seed, key) < p;
}

/** A stable integer in [min, max]. */
export function drawInt(seed: number, key: string, min: number, max: number): number {
  return min + Math.floor(draw(seed, key) * (max - min + 1));
}
