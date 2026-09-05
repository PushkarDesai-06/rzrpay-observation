import { describe, it, expect } from "vitest";
import { resolveLlmConfig, selectAgent, loadConfig, LlmProvider } from "@/config";

const env = (overrides: Record<string, string>): NodeJS.ProcessEnv =>
  overrides as NodeJS.ProcessEnv;

describe("provider auto-detection", () => {
  it("picks Anthropic from an Anthropic key", () => {
    const config = resolveLlmConfig(env({ ANTHROPIC_API_KEY: "sk-ant-x" }));
    expect(config.provider).toBe(LlmProvider.ANTHROPIC);
    expect(config.model).toBe("claude-opus-5");
  });

  it("picks an OpenAI-compatible endpoint from an OpenAI key", () => {
    const config = resolveLlmConfig(env({ OPENAI_API_KEY: "sk-x" }));
    expect(config.provider).toBe(LlmProvider.OPENAI);
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
  });

  it("treats a bare base URL plus a key as an OpenAI-compatible gateway", () => {
    const config = resolveLlmConfig(
      env({ LLM_BASE_URL: "http://localhost:11434/v1", LLM_API_KEY: "ollama" }),
    );
    expect(config.provider).toBe(LlmProvider.OPENAI);
    expect(config.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("honours an explicit provider over auto-detection", () => {
    const config = resolveLlmConfig(
      env({
        LLM_PROVIDER: "openai",
        ANTHROPIC_API_KEY: "sk-ant-x",
        LLM_API_KEY: "sk-x",
        LLM_BASE_URL: "https://openrouter.ai/api/v1",
      }),
    );
    expect(config.provider).toBe(LlmProvider.OPENAI);
  });

  it("reports no provider when nothing is configured", () => {
    expect(resolveLlmConfig(env({})).provider).toBe(LlmProvider.NONE);
  });

  it("can be switched off explicitly even with a key present", () => {
    const config = resolveLlmConfig(env({ LLM_PROVIDER: "none", ANTHROPIC_API_KEY: "sk-ant-x" }));
    expect(config.provider).toBe(LlmProvider.NONE);
  });
});

describe("any base URL, any model", () => {
  it("accepts an arbitrary endpoint and model together", () => {
    const config = resolveLlmConfig(
      env({
        LLM_PROVIDER: "openai",
        LLM_BASE_URL: "https://my-gateway.internal/v1",
        LLM_API_KEY: "k",
        LLM_MODEL: "llama-3.3-70b-instruct",
      }),
    );
    expect(config.baseUrl).toBe("https://my-gateway.internal/v1");
    expect(config.model).toBe("llama-3.3-70b-instruct");
  });

  it("lets a proxy stand in for the Anthropic API", () => {
    const config = resolveLlmConfig(
      env({
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_BASE_URL: "https://proxy.internal/anthropic",
        LLM_MODEL: "claude-sonnet-5",
      }),
    );
    expect(config.provider).toBe(LlmProvider.ANTHROPIC);
    expect(config.baseUrl).toBe("https://proxy.internal/anthropic");
    expect(config.model).toBe("claude-sonnet-5");
  });

  it("allows json_schema to be turned off for gateways that reject it", () => {
    expect(resolveLlmConfig(env({ LLM_JSON_SCHEMA: "false" })).useJsonSchema).toBe(false);
    expect(resolveLlmConfig(env({})).useJsonSchema).toBe(true);
  });

  it("parses extra headers, and shrugs off malformed ones", () => {
    expect(
      resolveLlmConfig(env({ LLM_HEADERS: '{"HTTP-Referer":"https://example.com"}' })).headers,
    ).toEqual({ "HTTP-Referer": "https://example.com" });
    expect(resolveLlmConfig(env({ LLM_HEADERS: "not json" })).headers).toEqual({});
  });

  it("ignores blank values rather than treating them as configured", () => {
    const config = resolveLlmConfig(env({ ANTHROPIC_API_KEY: "   ", LLM_MODEL: "" }));
    expect(config.provider).toBe(LlmProvider.NONE);
  });
});

describe("agent selection", () => {
  it("falls back to the deterministic decider with no credentials", () => {
    const selected = selectAgent(loadConfig(env({})));
    expect(selected.usingModel).toBe(false);
    expect(selected.description).toContain("deterministic heuristic");
  });

  it("describes the model and endpoint it is actually using", () => {
    const selected = selectAgent(
      loadConfig(
        env({
          LLM_PROVIDER: "openai",
          LLM_BASE_URL: "https://openrouter.ai/api/v1",
          LLM_API_KEY: "k",
          LLM_MODEL: "anthropic/claude-sonnet-5",
        }),
      ),
    );
    expect(selected.usingModel).toBe(true);
    expect(selected.description).toContain("anthropic/claude-sonnet-5");
    expect(selected.description).toContain("openrouter.ai");
  });

  it("refuses to claim a model when the configuration is incomplete", () => {
    const selected = selectAgent(loadConfig(env({ LLM_PROVIDER: "openai", LLM_MODEL: "x" })));
    expect(selected.usingModel).toBe(false);
    // Naming the missing variable is the whole point: "not configured" and
    // "half configured" have different fixes.
    expect(selected.description).toContain("LLM_API_KEY");
  });

  it("says which variable is missing, not just that something is", () => {
    const noBaseUrl = selectAgent(
      loadConfig(env({ LLM_PROVIDER: "openai", LLM_API_KEY: "k", LLM_MODEL: "m", LLM_BASE_URL: "" })),
    );
    // OpenAI-compatible resolution supplies a default base URL, so the only
    // genuinely missing pieces are reported.
    expect(noBaseUrl.usingModel).toBe(true);

    const noModel = selectAgent(loadConfig(env({ LLM_PROVIDER: "anthropic" })));
    expect(noModel.description).toContain("LLM_API_KEY");
  });

  it("distinguishes 'switched off' from 'never configured'", () => {
    const off = selectAgent(
      loadConfig(
        env({
          LLM_PROVIDER: "none",
          LLM_API_KEY: "k",
          LLM_BASE_URL: "https://gateway.test/v1",
          LLM_MODEL: "m",
        }),
      ),
    );
    expect(off.usingModel).toBe(false);
    expect(off.description).toContain("LLM_PROVIDER=none");

    const never = selectAgent(loadConfig(env({})));
    expect(never.description).toContain("no LLM configured");
  });
});
