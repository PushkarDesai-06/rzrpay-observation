import { z } from "zod";
import type { RecoveryContext } from "@/core/context/recovery-context";
import { DecisionSchema, parseDecision, InvalidDecisionError } from "@/core/agent/decision-schema";
import { SYSTEM_PROMPT, buildUserMessage, buildRepairMessage } from "@/core/agent/prompt";
import { decideWithFallback } from "@/core/agent/decide-with-fallback";
import type { AgentDecisionResult, RecoveryAgent } from "@/core/agent/recovery-agent";

export interface OpenAICompatibleOptions {
  /** Full chat-completions base, e.g. https://openrouter.ai/api/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Some gateways reject json_schema; set false to send json_object instead. */
  useJsonSchema?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Extra headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  headers?: Record<string, string>;
  /** How many times to wait out a rate limit before giving up on a call. */
  rateLimitRetries?: number;
  /** Longest single pause honoured for a rate limit. */
  maxRateLimitWaitMs?: number;
}

/** Zod 4 emits `additionalProperties: false` and `required`, which strict mode needs. */
const JSON_SCHEMA = z.toJSONSchema(DecisionSchema);

/** Status codes a gateway uses to reject an unsupported request parameter. */
const UNSUPPORTED_PARAM_STATUSES: readonly number[] = [400, 422];

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Seconds from the endpoint's `retry-after` header, when it sent one. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Decider for any OpenAI-compatible chat-completions endpoint.
 *
 * Deliberately built on plain `fetch` rather than a vendor SDK: the surface we
 * need is one POST, and every gateway worth pointing at — OpenRouter, LiteLLM,
 * vLLM, Ollama, a company proxy — speaks it. That keeps the dependency list
 * honest and means "any base URL, any model" is true rather than aspirational.
 *
 * Structured output degrades in three steps, because gateway support varies:
 *   1. `json_schema` with strict validation, where supported
 *   2. `json_object`, where only that is supported
 *   3. whatever text came back, fence-stripped and parsed
 * Every path ends at the same Zod validation, so a model that ignores the
 * schema entirely is a validation failure — never an unvetted instruction.
 */
export class OpenAICompatibleRecoveryAgent implements RecoveryAgent {
  readonly name = "openai-compatible";
  private readonly options: Required<Omit<OpenAICompatibleOptions, "headers">> & {
    headers: Record<string, string>;
  };
  /** Flipped off permanently if the endpoint rejects json_schema. */
  private jsonSchemaSupported: boolean;

  constructor(options: OpenAICompatibleOptions) {
    this.options = {
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
      apiKey: options.apiKey,
      model: options.model,
      useJsonSchema: options.useJsonSchema ?? true,
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens ?? 2048,
      timeoutMs: options.timeoutMs ?? 60_000,
      headers: options.headers ?? {},
      rateLimitRetries: options.rateLimitRetries ?? 4,
      maxRateLimitWaitMs: options.maxRateLimitWaitMs ?? 30_000,
    };
    this.jsonSchemaSupported = this.options.useJsonSchema;
  }

  decide(context: RecoveryContext): Promise<AgentDecisionResult> {
    return decideWithFallback({
      context,
      model: this.options.model,
      isRetryable,
      describeError,
      attempt: async ({ priorIssues }) => {
        const messages: Array<{ role: string; content: string }> = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserMessage(context) },
        ];
        if (priorIssues.length > 0) {
          messages.push({ role: "user", content: buildRepairMessage(priorIssues) });
        }

        const raw = await this.call(messages);
        return { decision: parseDecision(raw), raw };
      },
    });
  }

  /**
   * Issue the request, waiting out rate limits rather than burning attempts on
   * them.
   *
   * A 429 is not a bad answer — it is "not yet". Retrying it instantly, as the
   * generic attempt loop would, guarantees a second failure and drops the case
   * to the heuristic decider for no reason. A shared free-tier endpoint makes
   * this the difference between a model-driven run and a rules-driven one
   * wearing a model's label.
   */
  private async call(messages: Array<{ role: string; content: string }>): Promise<unknown> {
    for (let waited = 0; ; waited += 1) {
      try {
        return await this.attemptCall(messages);
      } catch (error) {
        const retryAfterMs = rateLimitDelayMs(error);
        if (
          retryAfterMs === null ||
          waited >= this.options.rateLimitRetries ||
          retryAfterMs > this.options.maxRateLimitWaitMs
        ) {
          throw error;
        }
        await sleep(retryAfterMs);
      }
    }
  }

  private async attemptCall(messages: Array<{ role: string; content: string }>): Promise<unknown> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages,
      temperature: this.options.temperature,
      max_tokens: this.options.maxTokens,
    };

    body.response_format = this.jsonSchemaSupported
      ? {
          type: "json_schema",
          json_schema: { name: "recovery_decision", strict: true, schema: JSON_SCHEMA },
        }
      : { type: "json_object" };

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
          ...this.options.headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `Request to ${this.options.baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);

      // A gateway that cannot do json_schema rejects the request as malformed.
      // Drop to json_object for the rest of this process rather than failing
      // the case. Restricted to the "bad request" codes: an auth or rate-limit
      // failure says nothing about schema support, and treating it as one both
      // degrades output quality and wastes a second call.
      if (this.jsonSchemaSupported && UNSUPPORTED_PARAM_STATUSES.includes(response.status)) {
        this.jsonSchemaSupported = false;
        throw new InvalidDecisionError(
          [`endpoint rejected json_schema (HTTP ${response.status}); retrying in json_object mode`],
          detail,
        );
      }
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      throw new HttpError(
        response.status,
        `HTTP ${response.status}: ${detail}`,
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new InvalidDecisionError(["response contained no message content"], payload);
    }

    return parseJsonLoosely(content);
  }
}

/**
 * Models routinely wrap JSON in prose or code fences however firmly they are
 * told not to. Recovering the object is cheap; failing a case over a fence is
 * not. Anything still unparseable becomes a schema violation like any other.
 */
export function parseJsonLoosely(content: string): unknown {
  const trimmed = content.trim();
  const candidates = [trimmed];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next shape.
    }
  }
  throw new InvalidDecisionError(["response was not valid JSON"], content);
}

function describeError(error: unknown, attempt: number): string {
  if (error instanceof InvalidDecisionError) return `attempt ${attempt}: ${error.issues.join("; ")}`;
  if (error instanceof HttpError) return `attempt ${attempt}: ${error.message}`;
  return `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`;
}

/** Auth and not-found failures will fail identically next time; don't spend the call. */
function isRetryable(error: unknown): boolean {
  if (error instanceof InvalidDecisionError) return true;
  if (error instanceof HttpError) return ![401, 403, 404].includes(error.status);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before re-issuing a rate-limited request.
 *
 * Prefers the endpoint's own advice — the `retry-after` header, then the delay
 * most gateways quote in the error body ("try again in 12.19s") — and pads it
 * slightly so the retry lands after the window rather than on its edge.
 * Returns null when the error was not a rate limit.
 */
export function rateLimitDelayMs(error: unknown): number | null {
  if (!(error instanceof HttpError) || error.status !== 429) return null;

  const header = error.retryAfterSeconds;
  if (header !== null && Number.isFinite(header)) return Math.ceil(header * 1000) + 250;

  const quoted = /try again in ([\d.]+)\s*(ms|s)\b/i.exec(error.message);
  if (quoted?.[1]) {
    const value = Number(quoted[1]);
    const ms = quoted[2]?.toLowerCase() === "ms" ? value : value * 1000;
    if (Number.isFinite(ms)) return Math.ceil(ms) + 250;
  }

  // Rate limited but told nothing useful — wait a conservative beat.
  return 5_000;
}
