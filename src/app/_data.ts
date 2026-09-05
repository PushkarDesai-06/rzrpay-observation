import "server-only";
import { getDatabase } from "@/db/client";
import { SystemClock } from "@/core/clock";
import { MetricsService } from "@/services/metrics-service";
import { CaseRepository } from "@/db/repositories/case-repository";
import { CustomerRepository } from "@/db/repositories/customer-repository";
import { PaymentRepository } from "@/db/repositories/payment-repository";
import { DecisionRepository } from "@/db/repositories/decision-repository";
import { PolicyRepository } from "@/db/repositories/policy-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { AuditRepository } from "@/db/repositories/audit-repository";
import { OutboxRepository } from "@/db/repositories/outbox-repository";
import { readLinkUrl } from "@/services/action-executor";
import type { MetricsSnapshot } from "@/core/metrics/metrics";

/**
 * Read-side for the dashboard.
 *
 * Pages get plain serialisable data; every repository and service stays on the
 * server. Nothing here writes — the interface reports what the loop did, it
 * does not become a second way to change case state.
 */

const clock = new SystemClock();
const db = () => getDatabase();

export interface CaseRow {
  id: string;
  paymentId: string;
  customerName: string;
  amountPaise: number;
  state: string;
  diagnosis: string | null;
  confidence: number | null;
  recoveredAmountPaise: number | null;
  openedAt: string;
  hoursOpen: number;
  decisionSource: string | null;
}

export function getMetrics(): MetricsSnapshot {
  return new MetricsService(db(), clock).snapshot();
}

export function listCases(limit = 200): CaseRow[] {
  const cases = new CaseRepository(db());
  const customers = new CustomerRepository(db());
  const decisions = new DecisionRepository(db());
  const now = clock.now();

  return cases.list({ limit }).map((c) => ({
    id: c.id,
    paymentId: c.paymentId,
    customerName: customers.find(c.customerId)?.name ?? c.customerId,
    amountPaise: c.amountPaise,
    state: c.state,
    diagnosis: c.diagnosis,
    confidence: c.confidence,
    recoveredAmountPaise: c.recoveredAmountPaise,
    openedAt: c.openedAt.toISOString(),
    hoursOpen: (now.getTime() - c.openedAt.getTime()) / 3_600_000,
    decisionSource: decisions.latestForCase(c.id)?.source ?? null,
  }));
}

export interface TimelineEntry {
  at: string;
  event: string;
  actor: string;
  detail: Record<string, unknown>;
}

export interface CaseDetail {
  id: string;
  paymentId: string;
  state: string;
  amountPaise: number;
  currency: string;
  recoveredAmountPaise: number | null;
  openedAt: string;
  closedAt: string | null;
  diagnosis: string | null;
  recoverability: string | null;
  confidence: number | null;
  cycleCount: number;
  customer: { id: string; name: string; email: string; successes: number; failures: number };
  payment: { method: string; failureCode: string | null; failureReasonRaw: string | null; attemptNumber: number };
  decisions: Array<{
    cycle: number; diagnosis: string; recoverability: string; confidence: number;
    action: string; reasoning: string; source: string; model: string | null; latencyMs: number | null;
  }>;
  policy: Array<{
    cycle: number; approved: boolean; originalAction: string; effectiveAction: string | null;
    ruleCode: string; reason: string;
  }>;
  actions: Array<{
    action: string; status: string; provider: string; externalRef: string | null;
    error: string | null; createdAt: string; paymentLinkUrl: string | null;
  }>;
  messages: Array<{ subject: string; body: string; recipient: string; transport: string; sentAt: string }>;
  timeline: TimelineEntry[];
}

export function getCase(caseId: string): CaseDetail | null {
  const cases = new CaseRepository(db());
  const found = cases.findById(caseId);
  if (!found) return null;

  const customer = new CustomerRepository(db()).require(found.customerId);
  const payment = new PaymentRepository(db()).require(found.paymentId);

  return {
    id: found.id,
    paymentId: found.paymentId,
    state: found.state,
    amountPaise: found.amountPaise,
    currency: found.currency,
    recoveredAmountPaise: found.recoveredAmountPaise,
    openedAt: found.openedAt.toISOString(),
    closedAt: found.closedAt?.toISOString() ?? null,
    diagnosis: found.diagnosis,
    recoverability: found.recoverability,
    confidence: found.confidence,
    cycleCount: found.cycleCount,
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      successes: customer.successfulPaymentsCount,
      failures: customer.failedPaymentsCount,
    },
    payment: {
      method: payment.method,
      failureCode: payment.failureCode,
      failureReasonRaw: payment.failureReasonRaw,
      attemptNumber: payment.attemptNumber,
    },
    decisions: new DecisionRepository(db()).forCase(caseId).map((d) => ({
      cycle: d.cycle,
      diagnosis: d.diagnosis,
      recoverability: d.recoverability,
      confidence: d.confidence,
      action: d.recommendedAction,
      reasoning: d.reasoningSummary,
      source: d.source,
      model: d.model,
      latencyMs: d.latencyMs,
    })),
    policy: new PolicyRepository(db()).forCase(caseId).map((p) => ({
      cycle: p.cycle,
      approved: p.approved,
      originalAction: p.originalAction,
      effectiveAction: p.effectiveAction,
      ruleCode: p.ruleCode,
      reason: p.reason,
    })),
    actions: new ActionRepository(db()).forCase(caseId).map((a) => ({
      action: a.action,
      status: a.status,
      provider: a.provider,
      externalRef: a.externalRef,
      paymentLinkUrl: readLinkUrl(a.result),
      error: a.error,
      createdAt: a.createdAt.toISOString(),
    })),
    messages: new OutboxRepository(db()).forCase(caseId).map((m) => ({
      subject: m.subject,
      body: m.body,
      recipient: m.recipient,
      transport: m.transport,
      sentAt: m.sentAt.toISOString(),
    })),
    timeline: new AuditRepository(db()).forCase(caseId).map((e) => ({
      at: e.at.toISOString(),
      event: e.event,
      actor: e.actor,
      detail: e.detail,
    })),
  };
}

export interface EscalationRow {
  id: string;
  paymentId: string;
  customerName: string;
  amountPaise: number;
  ruleCode: string;
  reason: string;
  confidence: number | null;
  escalatedAt: string;
}

/**
 * Cases the loop handed to a person, most money first.
 *
 * `ESCALATED` is terminal in the state machine, so nothing further happens to
 * these automatically. Surfacing them as a queue is the difference between the
 * system telling someone there is work and merely counting it.
 */
export function listEscalations(): EscalationRow[] {
  const rows = db()
    .prepare(
      `SELECT c.id            AS id,
              c.payment_id    AS paymentId,
              cu.name         AS customerName,
              c.amount_paise  AS amountPaise,
              c.confidence    AS confidence,
              COALESCE(c.closed_at, c.updated_at) AS escalatedAt,
              (SELECT p.rule_code FROM policy_evaluations p
                WHERE p.case_id = c.id ORDER BY p.cycle DESC LIMIT 1) AS ruleCode,
              (SELECT p.reason FROM policy_evaluations p
                WHERE p.case_id = c.id ORDER BY p.cycle DESC LIMIT 1) AS reason
         FROM recovery_cases c
         JOIN customers cu ON cu.id = c.customer_id
        WHERE c.state = 'ESCALATED'
        ORDER BY c.amount_paise DESC`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: String(r.id),
    paymentId: String(r.paymentId),
    customerName: String(r.customerName),
    amountPaise: Number(r.amountPaise),
    // "APPROVED" here means policy allowed an ESCALATE the decider asked for
    // itself, which reads as a contradiction next to the blocking rules.
    ruleCode:
      r.ruleCode === null
        ? "UNRECORDED"
        : r.ruleCode === "APPROVED"
          ? "AGENT_REQUESTED"
          : String(r.ruleCode),
    reason: r.reason === null ? "No policy evaluation recorded." : String(r.reason),
    confidence: r.confidence === null ? null : Number(r.confidence),
    escalatedAt: String(r.escalatedAt),
  }));
}
