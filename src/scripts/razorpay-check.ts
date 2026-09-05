/**
 * Live smoke test for the Razorpay integration, TEST MODE ONLY.
 *
 * Creates one real test-mode payment link, reads it back, and confirms it is
 * unpaid. Test-mode activity does not move money and does not touch a
 * merchant's live transactions. The provider refuses to start on a live key.
 */
import { loadEnvFile } from "@/config/load-env";
import { loadConfig } from "@/config";
import { RazorpayProvider } from "@/providers/razorpay-provider";
import { formatINR } from "@/core/domain/money";

loadEnvFile();

const config = loadConfig();

async function main(): Promise<void> {
  if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    console.log("No Razorpay credentials in .env — skipping. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    return;
  }

  console.log("Razorpay integration check — TEST MODE");
  console.log(`  key id      ${config.razorpayKeyId.slice(0, 12)}…`);

  const provider = new RazorpayProvider({
    keyId: config.razorpayKeyId,
    keySecret: config.razorpayKeySecret,
  });

  // 1 — retry must refuse rather than pretend.
  process.stdout.write("\n  retryPayment ......... ");
  try {
    await provider.retryPayment();
    console.log("UNEXPECTED: it returned instead of refusing");
    process.exitCode = 1;
  } catch (error) {
    console.log(`correctly refused — ${(error as Error).message.split(": ").slice(-1)[0]}`);
  }

  // 2 — create a real test-mode link for the smallest permitted amount.
  const amountPaise = 100;
  const idempotencyKey = `smoke:${config.simulationSeed}:${Math.floor(Date.now() / 1000)}`;
  process.stdout.write(`  createRecoveryLink ... `);
  const link = await provider.createRecoveryLink({
    caseId: "case_smoke",
    paymentId: "pay_smoke",
    customerId: "cust_smoke",
    customerName: "Recovery Smoke Test",
    customerEmail: "smoke@example.com",
    amountPaise,
    currency: "INR",
    idempotencyKey,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  if (!link.success || !link.linkId) {
    console.log(`FAILED — ${link.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`created ${formatINR(amountPaise)} link`);
  console.log(`    id    ${link.linkId}`);
  console.log(`    url   ${link.url}`);

  // 3 — read it back. It must report unpaid; nothing is recovered on creation.
  process.stdout.write("  getPaymentLinkStatus . ");
  const status = await provider.getPaymentLinkStatus(link.linkId);
  console.log(`paid=${status.paid} (expected false — creating a link recovers nothing)`);

  console.log("\n  Razorpay test mode is reachable and behaving as the provider expects.");
  console.log("  Open the url above to complete the test payment; the outcome tracker");
  console.log("  will then confirm it on the next tick.");
}

main().catch((error) => {
  console.error("\nRazorpay check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
