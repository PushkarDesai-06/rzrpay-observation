import { z } from "zod";
import {
  Diagnosis,
  Recoverability,
  RecoveryAction,
} from "@/core/domain/enums";
import type { RecoveryDecision } from "@/core/domain/types";

/**
 * The agent's entire output surface.
 *
 * Built from the same constants the executor switches on, so the model is
 * structurally incapable of naming an action the system does not implement.
 * A response that violates this schema is a validation failure, never a novel
 * instruction.
 */
export const DecisionSchema = z.object({
  diagnosis: z.enum(Diagnosis).describe("The most likely cause of the failure."),
  recoverability: z
    .enum(Recoverability)
    .describe("How likely this revenue is to be recovered at all."),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Calibrated confidence in this assessment, 0 to 1."),
  recommended_action: z
    .enum(RecoveryAction)
    .describe("The single intervention to attempt next."),
  reasoning_summary: z
    .string()
    .min(1)
    .max(400)
    .describe(
      "One or two sentences citing the specific evidence behind this decision. No internal deliberation.",
    ),
  expected_value_paise: z
    .number()
    .int()
    .min(0)
    .describe("Expected recoverable amount in paise: amount × probability of success."),
});

export type DecisionPayload = z.infer<typeof DecisionSchema>;

export class InvalidDecisionError extends Error {
  readonly issues: string[];
  readonly raw: unknown;

  constructor(issues: string[], raw: unknown) {
    super(`Agent returned an invalid decision: ${issues.join("; ")}`);
    this.name = "InvalidDecisionError";
    this.issues = issues;
    this.raw = raw;
  }
}

/**
 * Validate and convert to the internal shape.
 *
 * Nothing downstream ever touches the model's raw output — the policy engine
 * and the executor only ever see a value that has passed through here.
 */
export function parseDecision(raw: unknown): RecoveryDecision {
  const result = DecisionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new InvalidDecisionError(issues, raw);
  }
  const payload = result.data;
  return {
    diagnosis: payload.diagnosis,
    recoverability: payload.recoverability,
    confidence: payload.confidence,
    recommendedAction: payload.recommended_action,
    reasoningSummary: payload.reasoning_summary,
    expectedValuePaise: payload.expected_value_paise,
  };
}
