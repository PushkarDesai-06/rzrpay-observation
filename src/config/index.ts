import { SimulatedClock, SystemClock, type Clock } from "@/core/clock";
import { DEFAULT_POLICY, type RecoveryPolicy } from "@/core/policy/policy-config";
import { HeuristicRecoveryAgent, type RecoveryAgent } from "@/core/agent/recovery-agent";
import { createAnthropicAgent } from "@/core/agent/anthropic-agent";
import { OpenAICompatibleRecoveryAgent } from "@/core/agent/openai-agent";
import type { PaymentProvider } from "@/providers/payment-provider";
import { SimulatedPaymentProvider } from "@/providers/simulated-provider";
import { RazorpayProvider } from "@/providers/razorpay-provider";
import { CompositePaymentProvider } from "@/providers/composite-provider";

export const LlmProvider = {
  ANTHROPIC: "anthropic",
  OPENAI: "openai",
  NONE: "none",
} as const;
export type LlmProvider = (typeof LlmProvider)[keyof typeof LlmProvider];

export interface LlmConfig {
  provider: LlmProvider;
  baseUrl: string | undefined;
  apiKey: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  maxTokens: number | undefined;
  useJsonSchema: boolean;
  headers: Record<string, string>;
}

export interface AppConfig {
  databasePath: string;
  clockMode: string;
  simulationSeed: number;
  policy: RecoveryPolicy;
  llm: LlmConfig;
  razorpayKeyId: string | undefined;
  razorpayKeySecret: string | undefined;
}

const DEFAULT_MODEL: Readonly<Record<string, string>> = {
  [LlmProvider.ANTHROPIC]: "claude-opus-5",
  [LlmProvider.OPENAI]: "gpt-4o-mini",
};

const DEFAULT_BASE_URL: Readonly<Record<string, string>> = {
  [LlmProvider.OPENAI]: "https://api.openai.com/v1",
};

const pick = (...values: Array<string | undefined>): string | undefined =>
  values.find((value) => value !== undefined && value.trim() !== "");

/**
 * Resolve which model, at which endpoint, decides.
 *
 * `LLM_*` is the general form. The provider-specific names are kept as aliases
 * so an existing `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment
 * just works. When nothing is configured the system runs deterministically and
 * says so, rather than failing to start.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv): LlmConfig {
  const explicit = pick(env.LLM_PROVIDER)?.toLowerCase();

  const anthropicKey = pick(env.LLM_API_KEY, env.ANTHROPIC_API_KEY);
  const openaiKey = pick(env.LLM_API_KEY, env.OPENAI_API_KEY);
  const genericBase = pick(env.LLM_BASE_URL);

  let provider: LlmProvider;
  if (explicit === LlmProvider.ANTHROPIC || explicit === LlmProvider.OPENAI) {
    provider = explicit;
  } else if (explicit === LlmProvider.NONE) {
    provider = LlmProvider.NONE;
  } else if (pick(env.ANTHROPIC_API_KEY)) {
    provider = LlmProvider.ANTHROPIC;
  } else if (pick(env.OPENAI_API_KEY) || (genericBase && pick(env.LLM_API_KEY))) {
    // A bare base URL plus a key is overwhelmingly an OpenAI-compatible gateway.
    provider = LlmProvider.OPENAI;
  } else {
    provider = LlmProvider.NONE;
  }

  const apiKey = provider === LlmProvider.ANTHROPIC ? anthropicKey : openaiKey;
  const baseUrl = pick(
    genericBase,
    provider === LlmProvider.ANTHROPIC ? env.ANTHROPIC_BASE_URL : env.OPENAI_BASE_URL,
    DEFAULT_BASE_URL[provider],
  );
  const model = pick(
    env.LLM_MODEL,
    provider === LlmProvider.ANTHROPIC ? env.ANTHROPIC_MODEL : env.OPENAI_MODEL,
    DEFAULT_MODEL[provider],
  );

  const maxTokensRaw = pick(env.LLM_MAX_TOKENS);

  return {
    provider,
    baseUrl,
    apiKey,
    model,
    effort: pick(env.LLM_EFFORT, env.ANTHROPIC_EFFORT),
    maxTokens: maxTokensRaw ? Number(maxTokensRaw) : undefined,
    // Some gateways reject json_schema; LLM_JSON_SCHEMA=false drops to json_object.
    useJsonSchema: pick(env.LLM_JSON_SCHEMA)?.toLowerCase() !== "false",
    headers: parseHeaders(env.LLM_HEADERS),
  };
}

/** `LLM_HEADERS` is JSON, e.g. {"HTTP-Referer":"https://example.com"}. */
function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
      );
    }
  } catch {
    // Fall through — a malformed header blob should not stop the system.
  }
  console.warn("LLM_HEADERS is not a JSON object; ignoring it");
  return {};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    databasePath: env.DATABASE_PATH ?? "./data/recovery.db",
    clockMode: env.CLOCK_MODE ?? "simulated",
    simulationSeed: Number(env.SIMULATION_SEED ?? 20260830),
    policy: DEFAULT_POLICY,
    llm: resolveLlmConfig(env),
    razorpayKeyId: env.RAZORPAY_KEY_ID || undefined,
    razorpayKeySecret: env.RAZORPAY_KEY_SECRET || undefined,
  };
}

export function createClock(mode: string | undefined, start?: Date): Clock {
  return mode === "system" ? new SystemClock() : new SimulatedClock(start);
}

export interface SelectedAgent {
  agent: RecoveryAgent;
  usingModel: boolean;
  /** Human-readable provenance, printed in the demo and shown in the UI. */
  description: string;
}

/**
 * Build the decider described by the configuration.
 *
 * Missing or unusable credentials are not fatal: the system falls back to the
 * deterministic decider and reports that plainly. Every decision it makes is
 * still recorded as `heuristic_fallback`, so a run without a model is never
 * mistaken for one with a model.
 */
export function selectAgent(config: AppConfig): SelectedAgent {
  const { llm } = config;

  if (llm.provider === LlmProvider.ANTHROPIC && llm.apiKey && llm.model) {
    return {
      agent: createAnthropicAgent({
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
        model: llm.model,
        effort: llm.effort,
        maxTokens: llm.maxTokens,
      }),
      usingModel: true,
      description: `${llm.model} via Anthropic Messages API${llm.baseUrl ? ` @ ${llm.baseUrl}` : ""}`,
    };
  }

  if (llm.provider === LlmProvider.OPENAI && llm.apiKey && llm.model && llm.baseUrl) {
    return {
      agent: new OpenAICompatibleRecoveryAgent({
        baseUrl: llm.baseUrl,
        apiKey: llm.apiKey,
        model: llm.model,
        useJsonSchema: llm.useJsonSchema,
        ...(llm.maxTokens ? { maxTokens: llm.maxTokens } : {}),
        headers: llm.headers,
      }),
      usingModel: true,
      description: `${llm.model} via OpenAI-compatible API @ ${llm.baseUrl}`,
    };
  }

  // Say which of these it is. "Not configured" and "configured but switched
  // off" look identical from the outside and have completely different fixes.
  const hasCredentials = Boolean(llm.apiKey);
  let why: string;
  if (llm.provider === LlmProvider.NONE) {
    why = hasCredentials
      ? "LLM_PROVIDER=none is set, which disables the model even though credentials are present"
      : "no LLM configured";
  } else {
    const missing = [
      !llm.apiKey ? "LLM_API_KEY" : null,
      !llm.model ? "LLM_MODEL" : null,
      llm.provider === LlmProvider.OPENAI && !llm.baseUrl ? "LLM_BASE_URL" : null,
    ].filter((v): v is string => v !== null);
    why = `${llm.provider} selected but missing ${missing.join(", ")}`;
  }

  return {
    agent: new HeuristicRecoveryAgent(),
    usingModel: false,
    description: `deterministic heuristic (${why})`,
  };
}


export interface SelectedProvider {
  provider: PaymentProvider;
  /** The simulator, exposed so a seeder can register failure causes with it. */
  simulator: SimulatedPaymentProvider;
  usingRazorpay: boolean;
  description: string;
}

/**
 * Build the payment backend described by the configuration.
 *
 * With Razorpay test credentials present, payment links and their status go to
 * the real test-mode API while retries stay on the simulator — Razorpay cannot
 * re-charge a failed payment server-side, and pretending otherwise would make
 * the recovery numbers meaningless. Without credentials, everything is
 * simulated. Either way the split is reported, not hidden.
 */
export function selectPaymentProvider(
  config: AppConfig,
  clock: Clock,
  options: { simulateApiFailures?: boolean } = {},
): SelectedProvider {
  const simulator = new SimulatedPaymentProvider({
    seed: config.simulationSeed,
    clock,
    ...(options.simulateApiFailures !== undefined
      ? { simulateApiFailures: options.simulateApiFailures }
      : {}),
  });

  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    return {
      provider: simulator,
      simulator,
      usingRazorpay: false,
      description: "simulated (no Razorpay credentials configured)",
    };
  }

  const razorpay = new RazorpayProvider({
    keyId: config.razorpayKeyId,
    keySecret: config.razorpayKeySecret,
  });

  return {
    provider: new CompositePaymentProvider(simulator, razorpay),
    simulator,
    usingRazorpay: true,
    description: "retries: simulated · payment links: Razorpay TEST mode (no real money)",
  };
}
