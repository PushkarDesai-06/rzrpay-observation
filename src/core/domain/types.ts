import type {
  Diagnosis,
  DecisionSource,
  EventType,
  FailureCode,
  PaymentMethod,
  PaymentStatus,
  ProviderKind,
  Recoverability,
  RecoveryAction,
  RecoveryState,
} from "@/core/domain/enums";
import type { Paise } from "@/core/domain/money";

export interface Customer {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  lifetimeValuePaise: Paise;
  successfulPaymentsCount: number;
  failedPaymentsCount: number;
  lastSuccessfulPaymentAt: Date | null;
}

export interface Payment {
  id: string;
  customerId: string;
  amountPaise: Paise;
  currency: string;
  status: PaymentStatus;
  method: PaymentMethod;
  failureCode: FailureCode | null;
  failureReasonRaw: string | null;
  attemptNumber: number;
  provider: ProviderKind;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaymentEvent {
  id: string;
  idempotencyKey: string;
  type: EventType;
  paymentId: string | null;
  customerId: string | null;
  payload: Record<string, unknown>;
  receivedAt: Date;
  processedAt: Date | null;
  caseId: string | null;
}

export interface RecoveryCase {
  id: string;
  paymentId: string;
  customerId: string;
  amountPaise: Paise;
  currency: string;
  state: RecoveryState;
  diagnosis: Diagnosis | null;
  recoverability: Recoverability | null;
  confidence: number | null;
  cycleCount: number;
  openedAt: Date;
  updatedAt: Date;
  nextEvaluationAt: Date | null;
  closedAt: Date | null;
  recoveredAt: Date | null;
  recoveredAmountPaise: Paise | null;
}

export interface StateTransition {
  id: string;
  caseId: string;
  fromState: RecoveryState;
  toState: RecoveryState;
  trigger: string;
  detail: string | null;
  at: Date;
}

export interface AuditEntry {
  id: string;
  at: Date;
  caseId: string | null;
  event: string;
  actor: string;
  detail: Record<string, unknown>;
}

/** The agent's structured output. Validated before it is ever acted upon. */
export interface RecoveryDecision {
  diagnosis: Diagnosis;
  recoverability: Recoverability;
  confidence: number;
  recommendedAction: RecoveryAction;
  reasoningSummary: string;
  expectedValuePaise: Paise;
}

export interface RecordedDecision extends RecoveryDecision {
  id: string;
  caseId: string;
  cycle: number;
  source: DecisionSource;
  model: string | null;
  latencyMs: number | null;
  createdAt: Date;
}
