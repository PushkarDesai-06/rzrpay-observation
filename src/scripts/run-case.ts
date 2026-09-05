/**
 * Drive one case through the real recovery loop, right now.
 *
 * Exists to exercise the live Razorpay path on demand: `tick()` respects the
 * backoff a failed external call earns, which is correct but unhelpful when
 * you want to confirm a fix. Same services, same policy gate, no shortcuts.
 *
 *   npm run case -- <caseId|paymentId>
 */
import { loadEnvFile } from "@/config/load-env";
import { loadConfig, selectAgent, selectPaymentProvider } from "@/config";
import { openDatabase } from "@/db/client";
import { SystemClock } from "@/core/clock";
import { OutboxNotifier } from "@/providers/notifier";
import { RecoveryService } from "@/services/recovery-service";
import { CaseRepository } from "@/db/repositories/case-repository";
import { ActionRepository } from "@/db/repositories/action-repository";
import { PaymentRepository } from "@/db/repositories/payment-repository";
import { PaymentStatus } from "@/core/domain/enums";
import { formatINR } from "@/core/domain/money";

loadEnvFile();

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) throw new Error("Pass a case id or payment id");

  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const clock = new SystemClock();
  const { agent, description: decider } = selectAgent(config);
  const { provider, simulator, description } = selectPaymentProvider(config, clock);

  const cases = new CaseRepository(db);
  const payments = new PaymentRepository(db);
  const actions = new ActionRepository(db);

  const row = db
    .prepare("SELECT id FROM recovery_cases WHERE id = ? OR payment_id = ? LIMIT 1")
    .get(target, target) as { id: string } | undefined;
  if (!row) throw new Error(`No case for "${target}"`);

  const before = cases.requireById(row.id);
  const payment = payments.require(before.paymentId);
  if (payment.status === PaymentStatus.FAILED && payment.failureCode) {
    simulator.registerFailedPayment(payment.id, payment.failureCode);
  }

  console.log(`Case      ${before.id}`);
  console.log(`Payment   ${before.paymentId}  ${formatINR(before.amountPaise)}`);
  console.log(`State     ${before.state}  (cycle ${before.cycleCount})`);
  console.log(`Decider   ${decider}`);
  console.log(`Provider  ${description}\n`);

  const recovery = new RecoveryService(
    db, agent, provider, new OutboxNotifier(db, clock), clock, config.policy,
  );
  const result = await recovery.evaluate(before.id);

  const after = cases.requireById(before.id);
  console.log(`Decision  ${result.proposedAction} (${result.decisionSource})`);
  console.log(`Policy    ${result.policyOutcome} · ${result.policyRule} — ${result.policyReason}`);
  console.log(`Effective ${result.effectiveAction ?? "—"}`);
  console.log(`State     ${before.state} -> ${after.state}\n`);

  for (const action of actions.forCase(before.id).slice(-3)) {
    console.log(`  ${action.action}  via ${action.provider}  ${action.status}`);
    if (action.externalRef) console.log(`    ref   ${action.externalRef}`);
    if (action.error) console.log(`    error ${action.error}`);
  }
}

main().catch((error) => {
  console.error("Failed:", error);
  process.exitCode = 1;
});
