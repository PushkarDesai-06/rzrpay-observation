/**
 * Print the metrics snapshot for the current database.
 *
 * Every number is derived from stored rows at read time; nothing here is a
 * counter that was incremented as work happened.
 */
import { loadEnvFile } from "@/config/load-env";
import { openDatabase } from "@/db/client";
import { SystemClock } from "@/core/clock";
import { loadConfig } from "@/config";
import { MetricsService } from "@/services/metrics-service";
import { METRIC_DEFINITIONS, formatRate } from "@/core/metrics/metrics";
import { formatINR } from "@/core/domain/money";

loadEnvFile();

const config = loadConfig();
const db = openDatabase(config.databasePath);
const metrics = new MetricsService(db, new SystemClock());
const snap = metrics.snapshot();

const rule = (label: string) => console.log(`\n${label}\n${"─".repeat(64)}`);
const row = (label: string, value: string) => console.log(`  ${label.padEnd(30)} ${value}`);
const hours = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}h`);

console.log(`Recovery metrics — ${config.databasePath}`);
console.log(`Generated ${snap.generatedAt.toISOString()}`);

if (snap.cases.total === 0) {
  console.log("\nNo recovery cases yet. Run `npm run demo` or `npm run seed` first.\n");
  db.close();
  process.exit(0);
}

rule("MONEY");
row("Revenue at risk", formatINR(snap.revenue.atRiskPaise));
row("Revenue recovered", formatINR(snap.revenue.recoveredPaise));
row("Closed without recovery", formatINR(snap.revenue.unrecoveredPaise));

rule("CASES");
row("Total", String(snap.cases.total));
row("Open", String(snap.cases.open));
row("Recovered", String(snap.cases.recovered));
row("Failed", String(snap.cases.failed));
row("Not recoverable", String(snap.cases.notRecoverable));
row("Escalated", String(snap.cases.escalated));
row("Stopped", String(snap.cases.stopped));

rule("INTERVENTIONS");
row("Executed", String(snap.interventions.attempted));
row("Succeeded", String(snap.interventions.succeeded));
row("Failed", String(snap.interventions.failed));
row("Skipped as duplicate", String(snap.interventions.skippedDuplicate));
row("Cases with an intervention", String(snap.interventions.casesWithIntervention));

rule("RATES");
row("Recovery rate", formatRate(snap.rates.recoveryRate));
row("Intervention success rate", formatRate(snap.rates.interventionSuccessRate));
row("Escalation rate", formatRate(snap.rates.escalationRate));
row("Policy block rate", formatRate(snap.rates.policyBlockRate));

rule("TIME TO RECOVERY");
row("Average", hours(snap.timing.averageHoursToRecovery));
row("Median", hours(snap.timing.medianHoursToRecovery));
row("Fastest / slowest", `${hours(snap.timing.fastestHours)} / ${hours(snap.timing.slowestHours)}`);

rule("POLICY");
row("Evaluations", String(snap.policy.evaluations));
row("Approved", String(snap.policy.approved));
row("Blocked", String(snap.policy.blocked));
row("Overridden", String(snap.policy.overridden));
for (const block of snap.policy.blocksByRule) {
  row(`  ${block.ruleCode}`, String(block.count));
}

rule("ACTIONS");
console.log(`  ${"action".padEnd(22)}${"proposed".padStart(9)}${"run".padStart(6)}${"ok".padStart(5)}${"fail".padStart(6)}`);
for (const a of snap.actions) {
  console.log(
    `  ${a.action.padEnd(22)}${String(a.proposed).padStart(9)}${String(a.attempted).padStart(6)}${String(a.succeeded).padStart(5)}${String(a.failed).padStart(6)}`,
  );
}

rule("DIAGNOSES");
for (const d of snap.diagnoses) {
  row(d.diagnosis, `${d.cases} case(s), ${d.recovered} recovered`);
}

rule("DECISION PROVENANCE");
for (const s of snap.decisionSources) {
  row(s.source, String(s.count));
}

rule("HOW THE TWO HEADLINE NUMBERS ARE DEFINED");
console.log(`  Money recovered\n    ${METRIC_DEFINITIONS.moneyRecovered}`);
console.log(`\n  Recovery rate\n    ${METRIC_DEFINITIONS.recoveryRate}`);
console.log("");

db.close();
