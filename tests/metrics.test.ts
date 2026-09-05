import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openTestDatabase, type Database } from "@/db/client";
import { SimulatedClock } from "@/core/clock";
import { EventService } from "@/services/event-service";
import { RecoveryService } from "@/services/recovery-service";
import { MetricsService } from "@/services/metrics-service";
import { OutboxNotifier } from "@/providers/notifier";
import { HeuristicRecoveryAgent, FixtureRecoveryAgent, type RecoveryAgent } from "@/core/agent/recovery-agent";
import { CaseRepository } from "@/db/repositories/case-repository";
import { average, median, safeRate } from "@/core/metrics/metrics";
import {
  Diagnosis,
  FailureCode,
  PaymentMethod,
  PaymentStatus,
  ProviderKind,
  Recoverability,
  RecoveryAction,
} from "@/core/domain/enums";
import type {
  PaymentLinkResult,
  PaymentLinkStatus,
  PaymentProvider,
  PaymentResult,
} from "@/providers/payment-provider";
import type { RecoveryDecision } from "@/core/domain/types";

const START = new Date("2026-08-30T09:00:00.000Z");

class StubProvider implements PaymentProvider {
  readonly kind = ProviderKind.SIMULATED;
  retrySucceeds = false;
  linkGetsPaid = false;
  private captured = false;
  private linkPaid = false;

  retryPayment(): Promise<PaymentResult> {
    if (this.retrySucceeds) this.captured = true;
    return Promise.resolve({
      success: this.retrySucceeds,
      status: this.retrySucceeds ? PaymentStatus.CAPTURED : PaymentStatus.FAILED,
      externalReference: this.retrySucceeds ? "ref" : null,
      failureCode: this.retrySucceeds ? null : FailureCode.CARD_DECLINED,
      failureReasonRaw: this.retrySucceeds ? null : "declined",
      provider: this.kind,
      raw: {},
    });
  }
  createRecoveryLink(): Promise<PaymentLinkResult> {
    if (this.linkGetsPaid) this.linkPaid = true;
    return Promise.resolve({
      success: true, linkId: "link_1", url: "https://pay.test/1",
      provider: this.kind, raw: {}, error: null,
    });
  }
  getPaymentStatus(): Promise<PaymentStatus> {
    return Promise.resolve(this.captured ? PaymentStatus.CAPTURED : PaymentStatus.FAILED);
  }
  getPaymentLinkStatus(): Promise<PaymentLinkStatus> {
    return Promise.resolve({
      paid: this.linkPaid, paidAt: this.linkPaid ? START : null,
      amountPaise: this.linkPaid ? 249900 : null,
      externalReference: this.linkPaid ? "link_pay" : null,
    });
  }
}

let db: Database;
let clock: SimulatedClock;
let events: EventService;
let cases: CaseRepository;
let metrics: MetricsService;

beforeEach(() => {
  db = openTestDatabase();
  clock = new SimulatedClock(START);
  events = new EventService(db, clock);
  cases = new CaseRepository(db);
  metrics = new MetricsService(db, clock);
});
afterEach(() => db.close());

function openCase(paymentId: string, reason: string, amountPaise = 249900): string {
  return events.ingestPaymentFailed({
    provider: ProviderKind.SIMULATED,
    paymentId,
    customer: { id: `cust_${paymentId}`, name: "Asha", email: "a@example.com" },
    amountPaise,
    method: PaymentMethod.CARD,
    failureReasonRaw: reason,
  }).case.id;
}

function service(provider: PaymentProvider, agent: RecoveryAgent = new HeuristicRecoveryAgent()) {
  return new RecoveryService(db, agent, provider, new OutboxNotifier(db, clock), clock);
}

async function run(recovery: RecoveryService, caseId: string, maxRounds = 60): Promise<void> {
  for (let i = 0; i < maxRounds; i += 1) {
    if (cases.requireById(caseId).closedAt !== null) return;
    await recovery.tick();
    const after = cases.requireById(caseId);
    if (after.closedAt !== null) return;
    const next = after.nextEvaluationAt;
    if (next && next.getTime() > clock.now().getTime()) clock.set(next);
    else clock.advanceMinutes(30);
  }
}

describe("pure helpers", () => {
  it("reports zero rather than NaN on an empty denominator", () => {
    expect(safeRate(0, 0)).toBe(0);
    expect(safeRate(5, 0)).toBe(0);
    expect(safeRate(1, 4)).toBe(0.25);
  });

  it("computes average and median, and nulls on no data", () => {
    expect(average([])).toBeNull();
    expect(median([])).toBeNull();
    expect(average([1, 2, 3])).toBe(2);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("an attempt is never revenue", () => {
  it("counts a delivered payment link as ₹0 recovered until the customer pays", async () => {
    const provider = new StubProvider(); // link created, never paid
    const caseId = openCase("pay_1", "Card has expired");
    await run(service(provider), caseId, 90);

    const snap = metrics.snapshot();
    expect(snap.interventions.succeeded).toBeGreaterThan(0);
    expect(snap.revenue.recoveredPaise).toBe(0);
    expect(snap.cases.recovered).toBe(0);
  });

  it("counts a failed retry as an attempt but not a recovery", async () => {
    const caseId = openCase("pay_1", "Issuer bank unavailable");
    await run(service(new StubProvider()), caseId, 90);

    const snap = metrics.snapshot();
    expect(snap.interventions.attempted).toBeGreaterThan(0);
    expect(snap.revenue.recoveredPaise).toBe(0);
  });

  it("counts a confirmed capture exactly once", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;
    const caseId = openCase("pay_1", "Issuer bank unavailable");
    await run(service(provider), caseId);

    const snap = metrics.snapshot();
    expect(snap.cases.recovered).toBe(1);
    expect(snap.revenue.recoveredPaise).toBe(249900);
  });

  it("does not double count when the same failure is delivered repeatedly", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;
    const caseId = openCase("pay_1", "Issuer bank unavailable");
    for (let i = 0; i < 4; i += 1) openCase("pay_1", "Issuer bank unavailable");

    expect(metrics.snapshot().revenue.atRiskPaise).toBe(249900);
    await run(service(provider), caseId);

    const snap = metrics.snapshot();
    expect(snap.cases.total).toBe(1);
    expect(snap.revenue.recoveredPaise).toBe(249900);
  });
});

describe("revenue at risk tracks the active workflow", () => {
  it("drops a case out of at-risk the moment it closes", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;

    const first = openCase("pay_1", "Issuer bank unavailable", 100000);
    expect(metrics.snapshot().revenue.atRiskPaise).toBe(100000);

    await run(service(provider), first);

    // A second failure arrives after the first case has closed. A tick drives
    // every due case, so cases are opened around the run rather than together.
    openCase("pay_2", "Issuer bank unavailable", 250000);

    const snap = metrics.snapshot();
    expect(snap.revenue.atRiskPaise).toBe(250000);
    expect(snap.revenue.recoveredPaise).toBe(100000);
    expect(snap.cases.open).toBe(1);
    expect(snap.cases.recovered).toBe(1);
  });

  it("clears at-risk entirely once every case is closed", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;
    const a = openCase("pay_1", "Issuer bank unavailable", 100000);
    openCase("pay_2", "Issuer bank unavailable", 250000);

    expect(metrics.snapshot().revenue.atRiskPaise).toBe(350000);
    await run(service(provider), a);

    const snap = metrics.snapshot();
    expect(snap.cases.open).toBe(0);
    expect(snap.revenue.atRiskPaise).toBe(0);
    expect(snap.revenue.recoveredPaise).toBe(350000);
  });
});

describe("recovery rate", () => {
  it("excludes cases where nothing was ever attempted", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;

    // Recovered after a real intervention.
    const recovered = openCase("pay_1", "Issuer bank unavailable");
    await run(service(provider), recovered);

    // Escalated on an unexplained failure — no provider was ever contacted.
    const escalated = openCase("pay_2", "ERR_9999");
    await run(service(new StubProvider()), escalated);

    const snap = metrics.snapshot();
    expect(snap.cases.total).toBe(2);
    expect(snap.cases.escalated).toBe(1);
    expect(snap.interventions.casesWithIntervention).toBe(1);
    // 1 recovered ÷ 1 case actually attempted — not ÷ 2.
    expect(snap.rates.recoveryRate).toBe(1);
  });

  it("does not count WAIT as an intervention", async () => {
    const waiting: RecoveryDecision = {
      diagnosis: Diagnosis.TEMPORARY_FAILURE,
      recoverability: Recoverability.MEDIUM,
      confidence: 0.8,
      recommendedAction: RecoveryAction.WAIT,
      reasoningSummary: "Hold and reassess.",
      expectedValuePaise: 0,
    };
    const caseId = openCase("pay_1", "Issuer bank unavailable");
    await run(service(new StubProvider(), new FixtureRecoveryAgent([waiting])), caseId, 90);

    const snap = metrics.snapshot();
    const wait = snap.actions.find((a) => a.action === RecoveryAction.WAIT);
    expect(wait?.succeeded).toBeGreaterThan(0);
    // WAIT contacted nobody, so it must not inflate the attempt count.
    expect(snap.interventions.attempted).toBe(0);
    expect(snap.interventions.casesWithIntervention).toBe(0);
  });
});

describe("intervention success is not revenue success", () => {
  it("separates a delivered link from a paid one", async () => {
    const provider = new StubProvider(); // delivered, never paid
    const caseId = openCase("pay_1", "Card has expired");
    await run(service(provider), caseId, 90);

    const snap = metrics.snapshot();
    expect(snap.rates.interventionSuccessRate).toBeGreaterThan(0);
    expect(snap.rates.recoveryRate).toBe(0);
  });
});

describe("policy and provenance reporting", () => {
  it("records blocks per rule so the reason is queryable", async () => {
    const spamming: RecoveryDecision = {
      diagnosis: Diagnosis.CUSTOMER_ACTION_REQUIRED,
      recoverability: Recoverability.MEDIUM,
      confidence: 0.9,
      recommendedAction: RecoveryAction.SEND_REMINDER,
      reasoningSummary: "Chase again.",
      expectedValuePaise: 1000,
    };
    const caseId = openCase("pay_1", "Card has expired");
    await run(service(new StubProvider(), new FixtureRecoveryAgent([spamming])), caseId, 90);

    const snap = metrics.snapshot();
    expect(snap.policy.blocked).toBeGreaterThan(0);
    expect(snap.policy.blocksByRule.map((b) => b.ruleCode)).toContain("REMINDER_LIMIT_REACHED");
    expect(snap.policy.evaluations).toBe(snap.policy.approved + snap.policy.blocked);
  });

  it("reports which decider produced the decisions", async () => {
    const caseId = openCase("pay_1", "Issuer bank unavailable");
    await run(service(new StubProvider()), caseId, 30);
    const sources = metrics.snapshot().decisionSources;
    expect(sources.map((s) => s.source)).toContain("heuristic_fallback");
    expect(sources.reduce((n, s) => n + s.count, 0)).toBeGreaterThan(0);
  });

  it("counts policy overrides separately from blocks", async () => {
    const shaky: RecoveryDecision = {
      diagnosis: Diagnosis.TEMPORARY_FAILURE,
      recoverability: Recoverability.MEDIUM,
      confidence: 0.7, // below the financial-action floor
      recommendedAction: RecoveryAction.RETRY_PAYMENT,
      reasoningSummary: "Might be transient.",
      expectedValuePaise: 1000,
    };
    const caseId = openCase("pay_1", "Issuer bank unavailable");
    await run(service(new StubProvider(), new FixtureRecoveryAgent([shaky])), caseId, 30);

    expect(metrics.snapshot().policy.overridden).toBeGreaterThan(0);
  });
});

describe("timing", () => {
  it("reports nothing when nothing has been recovered", () => {
    const t = metrics.snapshot().timing;
    expect(t.averageHoursToRecovery).toBeNull();
    expect(t.medianHoursToRecovery).toBeNull();
  });

  it("measures from case opening to confirmed payment", async () => {
    const provider = new StubProvider();
    provider.retrySucceeds = true;
    const caseId = openCase("pay_1", "Issuer bank unavailable");
    await run(service(provider), caseId);

    const t = metrics.snapshot().timing;
    expect(t.averageHoursToRecovery).not.toBeNull();
    expect(t.averageHoursToRecovery!).toBeGreaterThan(0);
    expect(t.averageHoursToRecovery!).toBeLessThan(2);
  });
});

describe("an empty system", () => {
  it("reports zeroes rather than throwing or fabricating", () => {
    const snap = metrics.snapshot();
    expect(snap.cases.total).toBe(0);
    expect(snap.revenue.recoveredPaise).toBe(0);
    expect(snap.revenue.atRiskPaise).toBe(0);
    expect(snap.rates.recoveryRate).toBe(0);
    expect(snap.rates.interventionSuccessRate).toBe(0);
    expect(snap.actions.every((a) => a.attempted === 0)).toBe(true);
  });
});

describe("currency formatting", () => {
  it("renders whole paise correctly", async () => {
    const { formatINR } = await import("@/core/domain/money");
    expect(formatINR(0)).toBe("₹0");
    expect(formatINR(100)).toBe("₹1");
    expect(formatINR(249900)).toBe("₹2,499");
    expect(formatINR(249950)).toBe("₹2,499.50");
    expect(formatINR(-100)).toBe("-₹1");
  });

  it("survives a derived ratio rather than emitting two decimal points", async () => {
    const { formatINR } = await import("@/core/domain/money");
    // 123477_00 paise over 34 messages — a real value from the evaluation report.
    expect(formatINR(12347700 / 34)).toBe("₹3,631.68");
    expect(formatINR(1 / 3)).toBe("₹0");
    expect(formatINR(12345.6789)).not.toContain("..");
  });

  it("groups in the Indian numbering system", async () => {
    const { formatINR } = await import("@/core/domain/money");
    expect(formatINR(14197400)).toBe("₹1,41,974");
  });
});
