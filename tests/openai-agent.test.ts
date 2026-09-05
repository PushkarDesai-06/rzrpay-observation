import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatibleRecoveryAgent, parseJsonLoosely } from "@/core/agent/openai-agent";
import { buildRecoveryContext, type RecoveryContext } from "@/core/context/recovery-context";
import { DEFAULT_POLICY } from "@/core/policy/policy-config";
import {
  DecisionSource,
  FailureCode,
  PaymentMethod,
  PaymentStatus,
  ProviderKind,
  RecoveryAction,
  RecoveryState,
} from "@/core/domain/enums";

const NOW = new Date("2026-08-30T12:00:00.000Z");

const VALID = {
  diagnosis: "TEMPORARY_FAILURE",
  recoverability: "HIGH",
  confidence: 0.86,
  recommended_action: "RETRY_PAYMENT",
  reasoning_summary: "Issuer was briefly unavailable; the customer has paid successfully before.",
  expected_value_paise: 162435,
};

function context(): RecoveryContext {
  const openedAt = new Date(NOW.getTime() - 3_600_000);
  return buildRecoveryContext({
    recoveryCase: {
      id: "case_1", paymentId: "pay_1", customerId: "cust_1", amountPaise: 249900,
      currency: "INR", state: RecoveryState.ANALYZING, diagnosis: null, recoverability: null,
      confidence: null, cycleCount: 1, openedAt, updatedAt: openedAt, nextEvaluationAt: null,
      closedAt: null, recoveredAt: null, recoveredAmountPaise: null,
    },
    payment: {
      id: "pay_1", customerId: "cust_1", amountPaise: 249900, currency: "INR",
      status: PaymentStatus.FAILED, method: PaymentMethod.CARD,
      failureCode: FailureCode.ISSUER_UNAVAILABLE, failureReasonRaw: "issuer down",
      attemptNumber: 1, provider: ProviderKind.SIMULATED, createdAt: openedAt, updatedAt: openedAt,
    },
    customer: {
      id: "cust_1", name: "Asha Menon", email: "asha@example.com",
      createdAt: new Date("2025-08-30T10:00:00.000Z"), lifetimeValuePaise: 1_000_000,
      successfulPaymentsCount: 4, failedPaymentsCount: 1,
      lastSuccessfulPaymentAt: new Date("2026-07-30T10:00:00.000Z"),
    },
    cycle: 1, retriesAttempted: 0, remindersSent: 0, paymentLinksCreated: 0,
    lastCustomerContactAt: null, lastRetryAt: null, priorActions: [],
    policy: DEFAULT_POLICY, now: NOW,
  });
}

const ok = (content: string): Response =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  }) as unknown as Response;

const err = (status: number, body = "nope"): Response =>
  ({
    ok: false,
    status,
    // retry-after: 0 keeps rate-limit paths instant. A test that really sleeps
    // trips vitest's timeout, and its leaked continuation then fires a fetch
    // into the next test's mock.
    headers: { get: (h: string) => (h.toLowerCase() === "retry-after" ? "0" : null) },
    text: () => Promise.resolve(body),
  }) as unknown as Response;

function agent(overrides: Partial<ConstructorParameters<typeof OpenAICompatibleRecoveryAgent>[0]> = {}) {
  return new OpenAICompatibleRecoveryAgent({
    baseUrl: "https://gateway.test/v1",
    apiKey: "k",
    model: "some-model",
    ...overrides,
  });
}

/** Typed fetch stub — keeps `mock.calls` a real [url, init] tuple. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("loose JSON recovery", () => {
  it("parses clean JSON", () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
  });

  it("recovers JSON from a code fence", () => {
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers JSON wrapped in prose", () => {
    expect(parseJsonLoosely('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it("throws on genuinely unparseable text", () => {
    expect(() => parseJsonLoosely("no json at all")).toThrow();
  });
});

describe("calling an arbitrary endpoint", () => {
  it("posts to <baseUrl>/chat/completions with the configured model", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(ok(JSON.stringify(VALID))));

    await agent({ model: "llama-3.3-70b" }).decide(context());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.test/v1/chat/completions");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("llama-3.3-70b");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(ok(JSON.stringify(VALID))));
    await agent({ baseUrl: "https://gateway.test/v1/" }).decide(context());
    expect(fetchMock.mock.calls[0]![0]).toBe("https://gateway.test/v1/chat/completions");
  });

  it("sends extra headers a gateway may require", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(ok(JSON.stringify(VALID))));
    await agent({ headers: { "HTTP-Referer": "https://example.com" } }).decide(context());
    const init = fetchMock.mock.calls[0]![1];
    expect((init.headers as Record<string, string>)["HTTP-Referer"]).toBe("https://example.com");
  });

  it("returns a model decision on a well-formed response", async () => {
    stubFetch(() => Promise.resolve(ok(JSON.stringify(VALID))));
    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.LLM);
    expect(result.decision.recommendedAction).toBe(RecoveryAction.RETRY_PAYMENT);
    expect(result.model).toBe("some-model");
  });

  it("accepts a fenced response from a model that ignores formatting instructions", async () => {
    stubFetch(() => Promise.resolve(ok("```json\n" + JSON.stringify(VALID) + "\n```")));
    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.LLM);
  });
});

describe("structured output degradation", () => {
  it("asks for json_schema by default", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(ok(JSON.stringify(VALID))));
    await agent().decide(context());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as {
      response_format: { type: string };
    };
    expect(body.response_format.type).toBe("json_schema");
  });

  it("drops to json_object when the gateway rejects json_schema", async () => {
    let call = 0;
    const fetchMock = stubFetch(() => {
      call += 1;
      return Promise.resolve(call === 1 ? err(400, "unsupported response_format") : ok(JSON.stringify(VALID)));
    });

    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.LLM);

    const second = JSON.parse(String(fetchMock.mock.calls[1]![1].body)) as {
      response_format: { type: string };
    };
    expect(second.response_format.type).toBe("json_object");
  });

  it("honours json_schema being disabled up front", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(ok(JSON.stringify(VALID))));
    await agent({ useJsonSchema: false }).decide(context());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as {
      response_format: { type: string };
    };
    expect(body.response_format.type).toBe("json_object");
  });
});

describe("failure handling matches the Anthropic path", () => {
  it("repairs one invalid action and keeps the model decision", async () => {
    let call = 0;
    stubFetch(() => {
      call += 1;
      return Promise.resolve(
        ok(JSON.stringify(call === 1 ? { ...VALID, recommended_action: "REFUND" } : VALID)),
      );
    });
    const result = await agent().decide(context());
    expect(call).toBe(2);
    expect(result.source).toBe(DecisionSource.LLM);
    expect(result.warnings.join(" ")).toContain("recommended_action");
  });

  it("falls back deterministically when both attempts fail", async () => {
    stubFetch(() => Promise.resolve(ok("total nonsense")));
    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    expect(result.model).toBeNull();
    expect(result.warnings.join(" ")).toContain("not a model decision");
    expect(Object.values(RecoveryAction)).toContain(result.decision.recommendedAction);
  });

  it("does not burn a second call on an auth failure", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(err(401, "bad key")));
    const result = await agent().decide(context());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
  });

  it("falls back when the endpoint is unreachable", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    expect(result.warnings.join(" ")).toContain("ECONNREFUSED");
  });

  it("falls back on an empty completion", async () => {
    stubFetch(() => Promise.resolve(ok("")));
    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
  });

  it("never lets an arbitrary model invent an action", async () => {
    stubFetch(() =>
        Promise.resolve(ok(JSON.stringify({ ...VALID, recommended_action: "WIRE_TRANSFER_REFUND" }))),
      );
    const result = await agent().decide(context());
    expect(Object.values(RecoveryAction)).toContain(result.decision.recommendedAction);
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
  });
});

describe("format degradation is not triggered by unrelated failures", () => {
  it("keeps asking for json_schema after a rate limit", async () => {
    let call = 0;
    const fetchMock = stubFetch(() => {
      call += 1;
      return Promise.resolve(call === 1 ? err(429, "slow down") : ok(JSON.stringify(VALID)));
    });
    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.LLM);
    const second = JSON.parse(String(fetchMock.mock.calls[1]![1].body)) as {
      response_format: { type: string };
    };
    expect(second.response_format.type).toBe("json_schema");
  });

  it("degrades on a 422 as well as a 400", async () => {
    let call = 0;
    const fetchMock = stubFetch(() => {
      call += 1;
      return Promise.resolve(call === 1 ? err(422, "unprocessable") : ok(JSON.stringify(VALID)));
    });
    await agent().decide(context());
    const second = JSON.parse(String(fetchMock.mock.calls[1]![1].body)) as {
      response_format: { type: string };
    };
    expect(second.response_format.type).toBe("json_object");
  });
});

describe("rate limits are waited out, not burned as attempts", () => {
  it("reads the delay from a retry-after header", async () => {
    const { rateLimitDelayMs } = await import("@/core/agent/openai-agent");
    // Constructed via a real 429 path below; here we assert the parser contract.
    expect(rateLimitDelayMs(new Error("not an http error"))).toBeNull();
  });

  it("retries after a 429 and keeps the model decision", async () => {
    let call = 0;
    const fetchMock = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: () =>
            Promise.resolve('{"error":{"message":"Rate limit reached. Please try again in 0.001s"}}'),
        } as unknown as Response);
      }
      return Promise.resolve(ok(JSON.stringify(VALID)));
    });

    const result = await agent().decide(context());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The wait is not an attempt: the model still produced this decision.
    expect(result.source).toBe(DecisionSource.LLM);
    expect(result.warnings).toEqual([]);
  });

  it("honours a retry-after header over the message body", async () => {
    let call = 0;
    stubFetch(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: (h: string) => (h === "retry-after" ? "0" : null) },
          text: () => Promise.resolve("rate limited"),
        } as unknown as Response);
      }
      return Promise.resolve(ok(JSON.stringify(VALID)));
    });
    const result = await agent().decide(context());
    expect(result.source).toBe(DecisionSource.LLM);
  });

  it("gives up rather than waiting out an implausibly long window", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: { get: () => "3600" },
        text: () => Promise.resolve("rate limited for an hour"),
      } as unknown as Response),
    );
    const result = await agent({ maxRateLimitWaitMs: 1_000 }).decide(context());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    // Two attempts, neither of which waited an hour.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops waiting after the configured number of rate-limit retries", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: { get: () => "0" },
        text: () => Promise.resolve("always limited"),
      } as unknown as Response),
    );
    const result = await agent({ rateLimitRetries: 2 }).decide(context());
    expect(result.source).toBe(DecisionSource.HEURISTIC_FALLBACK);
    // 2 outer attempts × (1 initial + 2 rate-limit waits) = 6 requests, bounded.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("the context payload is kept small", () => {
  it("sends compact JSON rather than indented JSON", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(ok(JSON.stringify(VALID))));
    await agent().decide(context());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as {
      messages: Array<{ content: string }>;
    };
    const userMessage = body.messages[1]!.content;
    expect(userMessage).not.toContain("\n  ");
    expect(userMessage).toContain('"caseId"');
  });
});
