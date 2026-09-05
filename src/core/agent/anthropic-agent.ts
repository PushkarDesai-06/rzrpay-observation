import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { RecoveryContext } from "@/core/context/recovery-context";
import { DecisionSchema, parseDecision, InvalidDecisionError } from "@/core/agent/decision-schema";
import { SYSTEM_PROMPT, buildUserMessage, buildRepairMessage } from "@/core/agent/prompt";
import { decideWithFallback } from "@/core/agent/decide-with-fallback";
import type { AgentDecisionResult, RecoveryAgent } from "@/core/agent/recovery-agent";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicAgentOptions {
  model: string;
  /** low..max. Medium suits this bounded classification task. */
  effort: Effort;
  maxTokens: number;
  /** Point at a proxy or gateway that speaks the Anthropic Messages API. */
  baseUrl?: string | undefined;
}

export const DEFAULT_AGENT_OPTIONS: AnthropicAgentOptions = {
  model: "claude-opus-5",
  effort: "medium",
  maxTokens: 4096,
};

/**
 * The reasoning layer, over the Anthropic Messages API.
 *
 * One call per evaluation cycle — no agent loop, no tool round trips. The model
 * reads assembled context and returns one schema-constrained decision, and the
 * shared fallback policy handles anything that comes back wrong.
 *
 * `baseUrl` accepts any endpoint that speaks the Anthropic Messages API,
 * including structured outputs. For gateways that only speak the OpenAI
 * chat-completions shape, use OpenAICompatibleRecoveryAgent instead.
 */
export class AnthropicRecoveryAgent implements RecoveryAgent {
  readonly name = "anthropic";
  private readonly options: AnthropicAgentOptions;

  constructor(
    private readonly client: Anthropic,
    options: Partial<AnthropicAgentOptions> = {},
  ) {
    this.options = { ...DEFAULT_AGENT_OPTIONS, ...options };
  }

  decide(context: RecoveryContext): Promise<AgentDecisionResult> {
    return decideWithFallback({
      context,
      model: this.options.model,
      isRetryable,
      describeError,
      attempt: async ({ priorIssues }) => {
        const messages: Anthropic.MessageParam[] = [
          { role: "user", content: buildUserMessage(context) },
        ];
        if (priorIssues.length > 0) {
          messages.push({ role: "user", content: buildRepairMessage(priorIssues) });
        }

        const response = await this.client.messages.parse({
          model: this.options.model,
          max_tokens: this.options.maxTokens,
          system: SYSTEM_PROMPT,
          messages,
          output_config: {
            effort: this.options.effort,
            format: zodOutputFormat(DecisionSchema),
          },
        });

        if (response.stop_reason === "refusal") {
          throw new Error(
            `Model declined to answer (${response.stop_details?.category ?? "unknown"})`,
          );
        }
        const raw = response.parsed_output ?? response.content;
        if (!response.parsed_output) {
          throw new InvalidDecisionError(["response did not parse into the schema"], raw);
        }

        return { decision: parseDecision(response.parsed_output), raw };
      },
    });
  }
}

function describeError(error: unknown, attempt: number): string {
  if (error instanceof InvalidDecisionError) return `attempt ${attempt}: ${error.issues.join("; ")}`;
  if (error instanceof Anthropic.APIError) {
    return `attempt ${attempt}: API error ${error.status}: ${error.message}`;
  }
  return `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * A malformed response is worth one repair attempt. An auth or bad-request
 * failure will fail identically the second time, so don't spend the call.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof InvalidDecisionError) return true;
  if (error instanceof Anthropic.AuthenticationError) return false;
  if (error instanceof Anthropic.PermissionDeniedError) return false;
  if (error instanceof Anthropic.NotFoundError) return false;
  if (error instanceof Anthropic.BadRequestError) return false;
  return true;
}

export function createAnthropicAgent(options: {
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  maxTokens?: number | undefined;
}): AnthropicRecoveryAgent {
  const client = new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
  });
  return new AnthropicRecoveryAgent(client, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort as Effort } : {}),
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
}
