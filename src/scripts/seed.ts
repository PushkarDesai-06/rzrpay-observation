/**
 * Populate the working database with a synthetic recovery book.
 *
 * Runs the real loop over generated cases, so what lands in the database is
 * genuine workflow output — decisions, policy verdicts, actions and audit
 * entries — rather than fabricated rows. `npm run metrics` and the dashboard
 * read from this.
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
import { runArm } from "@/evaluation/harness";
import { summariseArm } from "@/evaluation/report";
import { formatINR } from "@/core/domain/money";
import { formatRate } from "@/core/metrics/metrics";
import { rmSync } from "node:fs";

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
const START = new Date("2026-08-30T09:00:00.000Z");

async function main(): Promise<void> {
  const { agent, description } = selectAgent(config);

  console.log("Seeding a synthetic recovery book");
  console.log(`  database   ${config.databasePath}`);
  console.log(`  decider    ${description}`);
  console.log(`  cases      ${size}   seed ${seed}`);
  console.log(`\n  ${DATASET_PROVENANCE}\n`);

  const dataset = generateDataset({ size, seed, detectedAt: START });

  console.log("  Failure mix");
  for (const row of describeMix(dataset)) {
    console.log(
      `    ${row.archetype.padEnd(26)} ${String(row.cases).padStart(3)} case(s)  ${formatINR(row.amountPaise)}`,
    );
  }
  console.log(`    ${"TOTAL AT RISK".padEnd(26)} ${String(dataset.length).padStart(3)} case(s)  ${formatINR(totalAtRiskPaise(dataset))}\n`);

  // Start from a clean book so repeated seeding does not stack up runs.
  rmSync(config.databasePath, { force: true });
  rmSync(`${config.databasePath}-wal`, { force: true });
  rmSync(`${config.databasePath}-shm`, { force: true });

  const result = await runArm({
    arm: "seed",
    decider: description,
    agent,
    dataset,
    seed,
    startAt: START,
    databasePath: config.databasePath,
    onProgress: (round, open) => {
      if (round % 20 === 0) process.stdout.write(`  round ${round} — ${open} case(s) open\r`);
    },
  });

  const summary = summariseArm(result, totalAtRiskPaise(dataset));

  console.log(`  Completed in ${result.rounds} rounds (${result.simulatedHours.toFixed(0)}h simulated)\n`);
  console.log(`  Recovered            ${summary.recoveredCases}/${summary.casesInBook} cases · ${formatINR(summary.recoveredPaise)}`);
  console.log(`  Recovery rate        ${formatRate(summary.recoveryRateOverBook)} of the book`);
  console.log(`  Escalated            ${summary.escalated}`);
  console.log(`  Policy blocks        ${summary.policyBlocks}`);
  console.log(`  Customer messages    ${summary.customerMessages}`);

  for (const caveat of summary.caveats) console.log(`\n  CAVEAT: ${caveat}`);

  console.log(`\n  Done. Inspect with \`npm run metrics\`.\n`);
}

main().catch((error) => {
  console.error("Seeding failed:", error);
  process.exitCode = 1;
});
