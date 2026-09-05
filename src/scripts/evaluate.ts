/**
 * Batch evaluation: does choosing the intervention beat a fixed rule?
 *
 * Every arm sees the same generated cases and the same seeded provider draws,
 * so the difference between them is the decision, not the luck. "We recovered
 * ₹X" means little on its own; "₹X against ₹Y for always-retry-once, on the
 * same book" is a claim worth making.
 */
import { loadEnvFile } from "@/config/load-env";
import { loadConfig, selectAgent } from "@/config";
import {
  DATASET_PROVENANCE,
  DEFAULT_DATASET_SIZE,
  describeMix,
  generateDataset,
  totalAtRiskPaise,
} from "@/evaluation/dataset";
import {
  AlwaysPaymentLinkBaseline,
  AlwaysRetryOnceBaseline,
  NoInterventionBaseline,
} from "@/evaluation/baselines";
import { runArm, type ArmResult } from "@/evaluation/harness";
import { compare, scenarioCoverage, summariseArm, type ArmSummary } from "@/evaluation/report";
import { HeuristicRecoveryAgent, type RecoveryAgent } from "@/core/agent/recovery-agent";
import { formatINR } from "@/core/domain/money";
import { formatRate } from "@/core/metrics/metrics";

loadEnvFile();

const config = loadConfig();
const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k ?? "", v ?? "true"];
  }),
);

const size = Number(args.get("cases") ?? DEFAULT_DATASET_SIZE);
const seed = Number(args.get("seed") ?? config.simulationSeed);
/** `--agent=heuristic` forces the rule-based decider even when a model is configured. */
const forceHeuristic = args.get("agent") === "heuristic";
const START = new Date("2026-08-30T09:00:00.000Z");

const REFERENCE_ARM = "retry-once";

interface Arm {
  name: string;
  decider: string;
  agent: RecoveryAgent;
}

function buildArms(): Arm[] {
  const selected = selectAgent(config);
  const agent = forceHeuristic ? new HeuristicRecoveryAgent() : selected.agent;
  const decider = forceHeuristic ? "deterministic heuristic (forced)" : selected.description;

  return [
    { name: "no-action", decider: "no intervention", agent: new NoInterventionBaseline() },
    { name: REFERENCE_ARM, decider: "fixed rule: retry once, then stop", agent: new AlwaysRetryOnceBaseline() },
    { name: "link-always", decider: "fixed rule: always send a payment link", agent: new AlwaysPaymentLinkBaseline() },
    { name: "agent", decider, agent },
  ];
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width);
}
function padStart(value: string, width: number): string {
  return value.length >= width ? value : value.padStart(width);
}

function printComparison(summaries: ArmSummary[]): void {
  const cols: Array<[string, number, (s: ArmSummary) => string]> = [
    ["arm", 13, (s) => s.arm],
    ["recovered", 11, (s) => `${s.recoveredCases}/${s.casesInBook}`],
    ["money", 12, (s) => formatINR(s.recoveredPaise)],
    ["rate", 8, (s) => formatRate(s.recoveryRateOverBook)],
    ["retries", 9, (s) => String(s.retries)],
    ["messages", 10, (s) => String(s.customerMessages)],
    ["escalated", 11, (s) => String(s.escalated)],
    ["blocked", 9, (s) => String(s.policyBlocks)],
  ];

  console.log(
    "  " + cols.map(([h, w], i) => (i === 0 ? pad(h, w) : padStart(h, w))).join(""),
  );
  console.log("  " + "─".repeat(cols.reduce((n, [, w]) => n + w, 0)));
  for (const s of summaries) {
    console.log(
      "  " +
        cols
          .map(([, w, get], i) => (i === 0 ? pad(get(s), w) : padStart(get(s), w)))
          .join(""),
    );
  }
}

async function main(): Promise<void> {
  const dataset = generateDataset({ size, seed, detectedAt: START });
  const atRisk = totalAtRiskPaise(dataset);

  console.log("Batch evaluation — recovery strategy comparison");
  console.log(`  cases ${size} · seed ${seed} · revenue at risk ${formatINR(atRisk)}`);
  console.log(`\n  ${DATASET_PROVENANCE}\n`);

  console.log("  Failure mix");
  for (const row of describeMix(dataset)) {
    console.log(`    ${pad(row.archetype, 26)} ${padStart(String(row.cases), 3)}  ${formatINR(row.amountPaise)}`);
  }
  console.log("");

  const results: ArmResult[] = [];
  for (const arm of buildArms()) {
    process.stdout.write(`  running ${pad(arm.name, 13)} `);
    const started = Date.now();
    const result = await runArm({
      arm: arm.name,
      decider: arm.decider,
      agent: arm.agent,
      dataset,
      seed,
      startAt: START,
    });
    results.push(result);
    console.log(`done — ${result.rounds} rounds, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const summaries = results.map((r) => summariseArm(r, atRisk));

  console.log("\nRESULTS\n");
  printComparison(summaries);

  const comparison = compare(summaries, REFERENCE_ARM);
  console.log(`\n  Uplift against "${REFERENCE_ARM}" (${formatINR(comparison.reference.recoveredPaise)} recovered)`);
  for (const s of summaries) {
    if (s.arm === REFERENCE_ARM) continue;
    const money = comparison.upliftPaise.get(s.arm) ?? 0;
    const cases = comparison.upliftCases.get(s.arm) ?? 0;
    const sign = money >= 0 ? "+" : "−";
    console.log(
      `    ${pad(s.arm, 13)} ${padStart(`${sign}${formatINR(Math.abs(money))}`, 12)}   ${sign}${Math.abs(cases)} case(s)`,
    );
  }

  console.log("\n  Cost of recovery — money recovered per customer message");
  for (const s of summaries) {
    const value = s.paisePerCustomerMessage;
    console.log(
      `    ${pad(s.arm, 13)} ${padStart(value === null ? "no messages sent" : formatINR(value), 18)}`,
    );
  }

  console.log("\n  Decider provenance");
  for (const [i, s] of summaries.entries()) {
    const sources = results[i]!.snapshot.decisionSources
      .map((d) => `${d.source}×${d.count}`)
      .join(", ");
    console.log(`    ${pad(s.arm, 13)} ${s.decider}`);
    console.log(`    ${pad("", 13)} ${sources || "no decisions recorded"}`);
  }

  const agentResult = results.find((r) => r.arm === "agent");
  if (agentResult) {
    console.log("\n  Scenario coverage in the agent arm");
    for (const row of scenarioCoverage(agentResult.outcomes)) {
      console.log(`    ${pad(row.scenario, 40)} ${padStart(String(row.cases), 4)}`);
    }
  }

  const caveats = summaries.flatMap((s) => s.caveats.map((c) => `${s.arm}: ${c}`));
  if (caveats.length > 0) {
    console.log("\n  CAVEATS");
    for (const c of caveats) console.log(`    ${c}`);
  }

  console.log("");
}

main().catch((error) => {
  console.error("Evaluation failed:", error);
  process.exitCode = 1;
});
