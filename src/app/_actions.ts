"use server";

import { revalidatePath } from "next/cache";
import { getRuntime } from "./_runtime";
import { getDatabase } from "@/db/client";
import { PaymentMethod, ProviderKind } from "@/core/domain/enums";
import { normaliseFailureReason } from "@/core/domain/failure-codes";
import { formatINR } from "@/core/domain/money";

/**
 * The console's write surface.
 *
 * Two verbs, both of which the CLI already had: put a failure into the system,
 * and let the loop run. Neither touches case state directly — that remains the
 * state machine's job, reached through `RecoveryService`.
 */

export interface ActionOutcome {
  ok: boolean;
  message: string;
}

/** Failure strings a real gateway might send, kept as free prose on purpose. */
const REASONS: Readonly<Record<string, string>> = {
  TRANSIENT: "Issuer bank unavailable, please retry",
  CVV: "Incorrect CVV entered by customer",
  FUNDS: "Insufficient funds in account",
  EXPIRED: "Card has expired",
  TIMEOUT: "Gateway timed out awaiting issuer response",
  AMBIGUOUS: "Transaction could not be completed",
};

const NAMES = [
  "Asha Menon", "Rohit Verma", "Kavya Iyer", "Imran Sheikh", "Neha Bansal",
  "Tarun Pillai", "Sana Qureshi", "Vikram Rao", "Divya Nair", "Arjun Kapoor",
];

export async function simulateFailure(formData: FormData): Promise<ActionOutcome> {
  const rupees = Number(formData.get("amount") ?? 0);
  const reasonKey = String(formData.get("reason") ?? "TRANSIENT");

  if (!Number.isFinite(rupees) || rupees <= 0) {
    return { ok: false, message: "Enter an amount greater than zero." };
  }

  const reason = REASONS[reasonKey] ?? REASONS.TRANSIENT!;
  const amountPaise = Math.round(rupees * 100);
  const { events } = getRuntime();

  // A stable per-payment suffix keeps ids readable in the table.
  const n = countPayments() + 1;
  const paymentId = `pay_ui_${String(n).padStart(4, "0")}`;
  const name = NAMES[n % NAMES.length]!;

  try {
    const result = events.ingestPaymentFailed({
      provider: ProviderKind.SIMULATED,
      paymentId,
      customer: {
        id: `cust_ui_${String(n).padStart(4, "0")}`,
        name,
        email: `${name.split(" ")[0]!.toLowerCase()}@example.com`,
      },
      amountPaise,
      method: PaymentMethod.CARD,
      failureReasonRaw: reason,
    });

    // Teach the simulator about the payment so a retry has something to act on.
    getRuntime().simulator?.registerFailedPayment(paymentId, normaliseFailureReason(reason));

    revalidatePath("/");
    return {
      ok: true,
      message: result.caseCreated
        ? `Case opened for ${paymentId} — ${formatINR(amountPaise)}, ${normaliseFailureReason(reason)}.`
        : `Duplicate ignored: ${result.reason}`,
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export async function runCycle(): Promise<ActionOutcome> {
  const { recovery } = getRuntime();
  try {
    const result = await recovery.tick();
    revalidatePath("/");

    if (result.evaluated === 0 && result.observed === 0) {
      return { ok: true, message: "No case was due for evaluation." };
    }
    const recovered =
      result.recovered > 0
        ? ` Recovered ${result.recovered} case(s), ${formatINR(result.recoveredAmountPaise)}.`
        : "";
    return {
      ok: true,
      message: `Evaluated ${result.evaluated}, observed ${result.observed}.${recovered}`,
    };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

function countPayments(): number {
  const row = getDatabase().prepare("SELECT COUNT(*) AS n FROM payments").get() as { n: number };
  return row.n;
}

/** Surface the real reason. A failed action that reads "something went wrong" is worse than useless. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
