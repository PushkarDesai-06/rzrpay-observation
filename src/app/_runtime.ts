import "server-only";
import { getDatabase } from "@/db/client";
import { SystemClock } from "@/core/clock";
import { loadConfig, selectAgent, selectPaymentProvider } from "@/config";
import { SimulatedPaymentProvider } from "@/providers/simulated-provider";
import { OutboxNotifier } from "@/providers/notifier";
import { EventService } from "@/services/event-service";
import { RecoveryService } from "@/services/recovery-service";
import { PaymentRepository } from "@/db/repositories/payment-repository";
import { PaymentStatus } from "@/core/domain/enums";

/**
 * Write-side composition root for the console.
 *
 * The UI gets no privileges the CLI does not have: buttons call the same
 * `EventService` and `RecoveryService` the scripts do, so a case triggered
 * from a browser still passes the policy gate and still lands in the audit
 * log. There is deliberately no repository write exposed to a page.
 */

interface Runtime {
  events: EventService;
  recovery: RecoveryService;
  decider: string;
  provider: string;
  /**
   * The simulated backend. Exposed only so a newly ingested failure can be
   * registered with the same instance the recovery service will retry
   * against — retries have no live counterpart, so one always exists.
   */
  simulator: SimulatedPaymentProvider;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;

  const db = getDatabase();
  const clock = new SystemClock();
  const config = loadConfig();
  const { agent, description: decider } = selectAgent(config);
  const { provider, simulator, description } = selectPaymentProvider(config, clock);

  // The simulator keeps its outstanding failures in memory, so a server
  // restart would leave cases in the database that it has never heard of and
  // every retry would throw. Replay the open failures back into it once.
  rehydrate(simulator, new PaymentRepository(db));

  runtime = {
    events: new EventService(db, clock),
    recovery: new RecoveryService(
      db,
      agent,
      provider,
      new OutboxNotifier(db, clock),
      clock,
      config.policy,
    ),
    decider,
    provider: description,
    simulator,
  };
  return runtime;
}

function rehydrate(provider: SimulatedPaymentProvider, payments: PaymentRepository): void {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.failure_code AS code
         FROM payments p
         JOIN recovery_cases c ON c.payment_id = p.id
        WHERE p.status = ? AND p.failure_code IS NOT NULL`,
    )
    .all(PaymentStatus.FAILED) as Array<{ id: string; code: string }>;

  for (const row of rows) {
    const payment = payments.find(row.id);
    if (payment?.failureCode) provider.registerFailedPayment(payment.id, payment.failureCode);
  }
}
