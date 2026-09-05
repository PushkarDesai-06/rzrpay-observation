import { describe, it, expect } from "vitest";
import type Razorpay from "razorpay";
import {
  RazorpayProvider,
  RAZORPAY_REFERENCE_ID_MAX,
  toReferenceId,
} from "@/providers/razorpay-provider";
import { CompositePaymentProvider } from "@/providers/composite-provider";
import { SimulatedPaymentProvider } from "@/providers/simulated-provider";
import { ProviderUnsupportedError } from "@/providers/payment-provider";
import { SimulatedClock } from "@/core/clock";
import { FailureCode, PaymentStatus, ProviderKind, RecoveryAction } from "@/core/domain/enums";

const START = new Date("2026-08-30T09:00:00.000Z");

interface StubCalls {
  createArgs: unknown[];
}

/** Stands in for the Razorpay SDK. No test in this file touches the network. */
function stubClient(
  overrides: {
    create?: (params: unknown) => Promise<unknown>;
    fetchLink?: (id: string) => Promise<unknown>;
    fetchPayment?: (id: string) => Promise<unknown>;
  } = {},
): { client: Razorpay; calls: StubCalls } {
  const calls: StubCalls = { createArgs: [] };
  const client = {
    paymentLink: {
      create: (params: unknown) => {
        calls.createArgs.push(params);
        return (
          overrides.create?.(params) ??
          Promise.resolve({
            id: "plink_test_1",
            short_url: "https://rzp.io/i/test1",
            status: "created",
            reference_id: "ref",
            amount: 249900,
            amount_paid: 0,
          })
        );
      },
      fetch: (id: string) =>
        overrides.fetchLink?.(id) ??
        Promise.resolve({ id, status: "created", amount: 249900, amount_paid: 0 }),
    },
    payments: {
      fetch: (id: string) =>
        overrides.fetchPayment?.(id) ?? Promise.resolve({ id, status: "failed" }),
    },
  } as unknown as Razorpay;
  return { client, calls };
}

const OPTS = { keyId: "rzp_test_abc123", keySecret: "secret" };

const linkParams = {
  caseId: "case_1",
  paymentId: "pay_1",
  customerId: "cust_1",
  customerName: "Asha Menon",
  customerEmail: "asha@example.com",
  amountPaise: 249900,
  currency: "INR",
  idempotencyKey: "case_1:CREATE_PAYMENT_LINK:1",
  expiresAt: new Date("2026-09-01T09:00:00.000Z"),
};

describe("test-mode safety", () => {
  it("refuses to start with a live key", () => {
    expect(() => new RazorpayProvider({ keyId: "rzp_live_abc", keySecret: "s" })).toThrow(
      /must be a test-mode key/,
    );
  });

  it("accepts a test key", () => {
    expect(() => new RazorpayProvider(OPTS, stubClient().client)).not.toThrow();
  });

  it("reports itself as test mode so results are never filed as production", () => {
    expect(new RazorpayProvider(OPTS, stubClient().client).kind).toBe(ProviderKind.RAZORPAY_TEST);
  });
});

describe("retry is refused rather than faked", () => {
  it("rejects with an explanation", async () => {
    const provider = new RazorpayProvider(OPTS, stubClient().client);
    await expect(provider.retryPayment()).rejects.toThrow(ProviderUnsupportedError);
    await expect(provider.retryPayment()).rejects.toThrow(/saved token or an active mandate/);
  });

  it("attributes a retry to the simulator, not to itself", () => {
    const provider = new RazorpayProvider(OPTS, stubClient().client);
    expect(provider.kindFor(RecoveryAction.RETRY_PAYMENT)).toBe(ProviderKind.SIMULATED);
    expect(provider.kindFor(RecoveryAction.CREATE_PAYMENT_LINK)).toBe(ProviderKind.RAZORPAY_TEST);
  });
});

describe("creating a payment link", () => {
  it("sends the amount in paise and the idempotency key as reference_id", async () => {
    const { client, calls } = stubClient();
    const result = await new RazorpayProvider(OPTS, client).createRecoveryLink(linkParams);

    expect(result.success).toBe(true);
    expect(result.linkId).toBe("plink_test_1");
    expect(result.url).toBe("https://rzp.io/i/test1");

    const sent = calls.createArgs[0] as Record<string, unknown>;
    expect(sent.amount).toBe(249900);
    expect(sent.reference_id).toBe("case_1:CREATE_PAYMENT_LINK:1");
    expect(sent.currency).toBe("INR");
  });

  it("keeps reference_id inside Razorpay's 40-character cap for a real case id", async () => {
    // Real ids are `case_` + 20 hex, so the natural key is 47 characters and
    // Razorpay answers 400. This is the shape that reaches production.
    const realKey = "case_46c504b5467f4a74981a:CREATE_PAYMENT_LINK:1";
    expect(realKey.length).toBeGreaterThan(RAZORPAY_REFERENCE_ID_MAX);

    const { client, calls } = stubClient();
    await new RazorpayProvider(OPTS, client).createRecoveryLink({
      ...linkParams,
      idempotencyKey: realKey,
    });

    const sent = calls.createArgs[0] as { reference_id: string };
    expect(sent.reference_id.length).toBeLessThanOrEqual(RAZORPAY_REFERENCE_ID_MAX);
    // Deterministic: the same key must reach the same link on a replay.
    expect(sent.reference_id).toBe(toReferenceId(realKey));
  });

  it("gives distinct reference ids to keys sharing a 40-character prefix", () => {
    const prefix = "case_46c504b5467f4a74981a:CREATE_PAYMENT_LINK:";
    // Truncation would collapse these two into one link and lose a recovery.
    expect(toReferenceId(`${prefix}1`)).not.toBe(toReferenceId(`${prefix}2`));
  });

  it("switches off Razorpay's own notifications and reminders", async () => {
    const { client, calls } = stubClient();
    await new RazorpayProvider(OPTS, client).createRecoveryLink(linkParams);

    const sent = calls.createArgs[0] as { notify: { email: boolean; sms: boolean }; reminder_enable: boolean };
    // Razorpay reminders would bypass this system's communication limits entirely.
    expect(sent.notify.email).toBe(false);
    expect(sent.notify.sms).toBe(false);
    expect(sent.reminder_enable).toBe(false);
  });

  it("sends expiry as unix seconds", async () => {
    const { client, calls } = stubClient();
    await new RazorpayProvider(OPTS, client).createRecoveryLink(linkParams);
    const sent = calls.createArgs[0] as { expire_by: number };
    expect(sent.expire_by).toBe(Math.floor(linkParams.expiresAt.getTime() / 1000));
  });

  it("reports an API failure instead of throwing", async () => {
    const { client } = stubClient({
      create: () => Promise.reject({ error: { code: "BAD_REQUEST_ERROR", description: "amount too low" } }),
    });
    const result = await new RazorpayProvider(OPTS, client).createRecoveryLink(linkParams);
    expect(result.success).toBe(false);
    expect(result.linkId).toBeNull();
    expect(result.error).toContain("amount too low");
  });
});

describe("observing a link", () => {
  it("treats a paid-in-full link as paid", async () => {
    const { client } = stubClient({
      fetchLink: (id) =>
        Promise.resolve({
          id, status: "paid", amount: 249900, amount_paid: 249900,
          payments: [{ payment_id: "pay_rzp_1", created_at: 1788000000 }],
        }),
    });
    const status = await new RazorpayProvider(OPTS, client).getPaymentLinkStatus("plink_1");
    expect(status.paid).toBe(true);
    expect(status.amountPaise).toBe(249900);
    expect(status.externalReference).toBe("pay_rzp_1");
  });

  it("does not treat a partially paid link as recovered", async () => {
    const { client } = stubClient({
      fetchLink: (id) => Promise.resolve({ id, status: "paid", amount: 249900, amount_paid: 100000 }),
    });
    const status = await new RazorpayProvider(OPTS, client).getPaymentLinkStatus("plink_1");
    expect(status.paid).toBe(false);
    expect(status.amountPaise).toBeNull();
  });

  it("reports an unpaid link as unpaid", async () => {
    const status = await new RazorpayProvider(OPTS, stubClient().client).getPaymentLinkStatus("plink_1");
    expect(status.paid).toBe(false);
  });

  it("treats an API failure as unresolved, never as success", async () => {
    const { client } = stubClient({ fetchLink: () => Promise.reject(new Error("network down")) });
    const status = await new RazorpayProvider(OPTS, client).getPaymentLinkStatus("plink_1");
    expect(status.paid).toBe(false);
    expect(status.externalReference).toBeNull();
  });
});

describe("payment status mapping", () => {
  it("maps captured to CAPTURED and everything unknown to FAILED", async () => {
    const captured = stubClient({ fetchPayment: (id) => Promise.resolve({ id, status: "captured" }) });
    expect(await new RazorpayProvider(OPTS, captured.client).getPaymentStatus("p")).toBe(
      PaymentStatus.CAPTURED,
    );

    const weird = stubClient({ fetchPayment: (id) => Promise.resolve({ id, status: "something_new" }) });
    expect(await new RazorpayProvider(OPTS, weird.client).getPaymentStatus("p")).toBe(
      PaymentStatus.FAILED,
    );
  });

  it("treats an unknown payment id as not captured", async () => {
    const { client } = stubClient({ fetchPayment: () => Promise.reject(new Error("not found")) });
    expect(await new RazorpayProvider(OPTS, client).getPaymentStatus("nope")).toBe(
      PaymentStatus.FAILED,
    );
  });
});

describe("the composite routes each capability honestly", () => {
  function composite() {
    const clock = new SimulatedClock(START);
    const simulator = new SimulatedPaymentProvider({ seed: 1, clock, simulateApiFailures: false });
    simulator.registerFailedPayment("pay_1", FailureCode.ISSUER_UNAVAILABLE);
    const razorpay = new RazorpayProvider(OPTS, stubClient().client);
    return { composite: new CompositePaymentProvider(simulator, razorpay), simulator };
  }

  it("sends retries to the simulator and links to Razorpay", async () => {
    const { composite: provider } = composite();

    const retry = await provider.retryPayment({
      paymentId: "pay_1", amountPaise: 249900, currency: "INR", idempotencyKey: "k1",
    });
    expect(retry.provider).toBe(ProviderKind.SIMULATED);

    const link = await provider.createRecoveryLink(linkParams);
    expect(link.provider).toBe(ProviderKind.RAZORPAY_TEST);
  });

  it("attributes each action to the backend that actually ran it", () => {
    const { composite: provider } = composite();
    expect(provider.kindFor(RecoveryAction.RETRY_PAYMENT)).toBe(ProviderKind.SIMULATED);
    expect(provider.kindFor(RecoveryAction.CREATE_PAYMENT_LINK)).toBe(ProviderKind.RAZORPAY_TEST);
  });

  it("states the split in plain words", () => {
    const { composite: provider } = composite();
    expect(provider.describe()).toContain("simulated");
    expect(provider.describe()).toContain("razorpay_test");
  });
});

describe("simulated retries decay across attempts", () => {
  it("values a second and third retry progressively less", () => {
    const sim = new SimulatedPaymentProvider({ seed: 1, clock: new SimulatedClock(START) });
    const first = sim.odds(FailureCode.ISSUER_UNAVAILABLE, 1).retry;
    const second = sim.odds(FailureCode.ISSUER_UNAVAILABLE, 2).retry;
    const third = sim.odds(FailureCode.ISSUER_UNAVAILABLE, 3).retry;

    expect(second).toBeLessThan(first);
    expect(third).toBeLessThan(second);

    // Independent draws would compound to ~97%, which no real payment book hits.
    const cumulative = 1 - (1 - first) * (1 - second) * (1 - third);
    expect(cumulative).toBeLessThan(0.85);
  });

  it("leaves payment-link conversion unaffected by retry count", () => {
    const sim = new SimulatedPaymentProvider({ seed: 1, clock: new SimulatedClock(START) });
    expect(sim.odds(FailureCode.CARD_EXPIRED, 3).link).toBe(sim.odds(FailureCode.CARD_EXPIRED, 1).link);
  });
});
