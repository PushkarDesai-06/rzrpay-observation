/**
 * Time is injected, never read ambiently.
 *
 * Policy rules reason in hours (24h between customer messages, a 72h recovery
 * window). A live demo lasts minutes, so the demo runs on a SimulatedClock that
 * can be advanced explicitly. Nothing under src/core/ may call Date.now().
 */

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class SimulatedClock implements Clock {
  #current: Date;

  constructor(start: Date = new Date()) {
    this.#current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  advanceMs(ms: number): Date {
    if (ms < 0) throw new RangeError("Simulated time only moves forward");
    this.#current = new Date(this.#current.getTime() + ms);
    return this.now();
  }

  advanceMinutes(minutes: number): Date {
    return this.advanceMs(minutes * 60_000);
  }

  advanceHours(hours: number): Date {
    return this.advanceMs(hours * 3_600_000);
  }

  set(at: Date): void {
    if (at.getTime() < this.#current.getTime()) {
      throw new RangeError("Simulated time only moves forward");
    }
    this.#current = new Date(at.getTime());
  }
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

export function minutesBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MINUTE_MS;
}

/** ISO-8601 UTC, the only format timestamps are persisted in. */
export function toIso(date: Date): string {
  return date.toISOString();
}

export function fromIso(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}
