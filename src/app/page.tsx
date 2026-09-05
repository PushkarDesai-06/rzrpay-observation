import Link from "next/link";
import { getMetrics, listCases, listEscalations } from "./_data";
import { getRuntime } from "./_runtime";
import { Controls } from "./_controls";
import {
  Chip,
  Kpi,
  Money,
  Mono,
  Panel,
  PanelNote,
  RuleTag,
  SourceBadge,
  StatePill,
} from "./_ui";
import { formatINR } from "@/core/domain/money";
import { formatRate, METRIC_DEFINITIONS } from "@/core/metrics/metrics";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// Reads live from SQLite on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

/** Running total of confirmed recoveries in the order cases were opened. Real data, no smoothing. */
function recoveredSeries(cases: ReturnType<typeof listCases>): number[] {
  let total = 0;
  return [...cases]
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
    .map((c) => (total += c.recoveredAmountPaise ?? 0));
}

const ACTION_LABEL: Record<string, string> = {
  RETRY_PAYMENT: "Retry payment",
  CREATE_PAYMENT_LINK: "Payment link",
  SEND_REMINDER: "Reminder",
  WAIT: "Wait",
  ESCALATE: "Escalate",
  STOP: "Stop",
};

export default function Dashboard() {
  const m = getMetrics();
  const cases = listCases();
  const escalations = listEscalations();
  const { decider, provider } = getRuntime();

  const hours = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}h`);
  const escalatedPaise = escalations.reduce((sum, e) => sum + e.amountPaise, 0);
  const bookPaise =
    m.revenue.atRiskPaise +
    m.revenue.recoveredPaise +
    m.revenue.unrecoveredPaise;
  const spark = recoveredSeries(cases);

  return (
    <div className="mx-auto max-w-[1240px] px-6 py-7">
      <header className="mb-7 flex flex-col flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Overview</h1>
        </div>
        <Controls />
      </header>

      {m.cases.total === 0 ? (
        <Panel title="No cases yet">
          <div className="text-muted-foreground px-4 py-14 text-center text-sm">
            <p className="text-foreground/80">Nothing has failed yet.</p>
            <p className="mt-1.5">
              Simulate a failure above, or run <Mono>npm run seed</Mono> for a
              full book.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi
              label="At risk"
              value={formatINR(m.revenue.atRiskPaise)}
              tone="amber"
              meter={bookPaise > 0 ? m.revenue.atRiskPaise / bookPaise : 0}
              note={`${m.cases.open} open · ${bookPaise > 0 ? formatRate(m.revenue.atRiskPaise / bookPaise) : "0%"} of book`}
            />
            <Kpi
              label="Recovered"
              value={formatINR(m.revenue.recoveredPaise)}
              tone="emerald"
              spark={spark}
              note={`${m.cases.recovered} confirmed captures`}
            />
            <Kpi
              label="Recovery rate"
              value={formatRate(m.rates.recoveryRate)}
              tone="emerald"
              meter={m.rates.recoveryRate}
              note={`${m.cases.recovered} of ${m.interventions.casesWithIntervention} intervened`}
            />
            <Kpi
              label="Time to recover"
              value={hours(m.timing.averageHoursToRecovery)}
              tone="sky"
              note={`median ${hours(m.timing.medianHoursToRecovery)}`}
              trend={
                m.timing.fastestHours !== null
                  ? {
                      label: `fastest ${hours(m.timing.fastestHours)}`,
                      variant: "sky",
                    }
                  : undefined
              }
            />
            <Kpi
              label="Escalations"
              value={String(m.cases.escalated)}
              tone="rose"
              note={formatINR(escalatedPaise)}
              trend={
                m.cases.escalated > 0
                  ? {
                      label: formatRate(m.rates.escalationRate),
                      variant: "rose",
                    }
                  : undefined
              }
            />
            <Kpi
              label="Policy blocks"
              value={String(m.policy.blocked)}
              tone="slate"
              note={`${m.policy.overridden} overridden · ${m.policy.evaluations} evaluated`}
              trend={
                m.policy.evaluations > 0
                  ? {
                      label: formatRate(m.rates.policyBlockRate),
                      variant: "slate",
                    }
                  : undefined
              }
            />
          </div>

          {escalations.length > 0 ? (
            <Panel
              title="Waiting on a human"
              meta={
                <>
                  <span>
                    {escalations.length}{" "}
                    {escalations.length <= 1 ? "case" : "cases"}
                  </span>
                  <span className="text-muted-foreground/40">·</span>
                  <span className="text-foreground/80">
                    {formatINR(escalatedPaise)}
                  </span>
                </>
              }
              className="mb-6"
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Case</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Why it escalated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {escalations.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <Link
                          href={`/cases/${e.id}`}
                          className="font-mono text-[11.5px] text-foreground/90 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                        >
                          {e.paymentId}
                        </Link>
                      </TableCell>
                      <TableCell>{e.customerName}</TableCell>
                      <TableCell className="text-right font-medium">
                        <Money paise={e.amountPaise} />
                      </TableCell>
                      {/* Reasons are full sentences; the table default would clip them. */}
                      <TableCell className="w-full max-w-0 whitespace-normal">
                        <RuleTag code={e.ruleCode} approved={false} />
                        <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
                          {e.reason}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          ) : null}

          <div className="mb-6 grid gap-4 lg:grid-cols-5">
            <Panel title="Interventions" className="lg:col-span-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead className="text-right">Proposed</TableHead>
                    <TableHead className="text-right">Run</TableHead>
                    <TableHead className="text-right">Succeeded</TableHead>
                    <TableHead className="w-[140px]">Success</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {m.actions
                    .filter((a) => a.proposed > 0 || a.attempted > 0)
                    .map((a) => {
                      const rate =
                        a.attempted > 0 ? a.succeeded / a.attempted : null;
                      return (
                        <TableRow key={a.action}>
                          <TableCell>
                            <span className="text-foreground/90">
                              {ACTION_LABEL[a.action] ?? a.action}
                            </span>
                            <span className="text-muted-foreground/60 ml-2 font-mono text-[10.5px]">
                              {a.action}
                            </span>
                          </TableCell>
                          <TableCell className="num text-right text-muted-foreground">
                            {a.proposed}
                          </TableCell>
                          <TableCell className="num text-right">
                            {a.attempted}
                          </TableCell>
                          <TableCell className="num text-right font-medium">
                            {a.succeeded}
                          </TableCell>
                          <TableCell>
                            {rate === null ? (
                              <span className="text-muted-foreground/50 num text-[11px]">
                                —
                              </span>
                            ) : (
                              <div className="flex items-center gap-2">
                                <div className="h-1 w-16 overflow-hidden rounded-full bg-white/6">
                                  <div
                                    className={cn(
                                      "h-full rounded-full",
                                      rate >= 0.99
                                        ? "bg-emerald-400"
                                        : rate >= 0.5
                                          ? "bg-amber-400"
                                          : "bg-rose-400",
                                    )}
                                    style={{ width: `${rate * 100}%` }}
                                  />
                                </div>
                                <span className="num text-muted-foreground text-[11px]">
                                  {formatRate(rate)}
                                </span>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                </TableBody>
              </Table>
            </Panel>

            <Panel title="Why actions were blocked" className="lg:col-span-2">
              {m.policy.blocksByRule.length === 0 ? (
                <p className="text-muted-foreground px-4 py-10 text-center text-sm">
                  No actions were blocked.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rule</TableHead>
                      <TableHead className="text-right">Blocks</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.policy.blocksByRule.map((b) => (
                      <TableRow key={b.ruleCode}>
                        <TableCell>
                          <RuleTag code={b.ruleCode} approved={false} />
                        </TableCell>
                        <TableCell className="num text-right font-medium">
                          {b.count}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Panel>
          </div>

          <Panel
            title="Recovery cases"
            meta={<span>{cases.length} shown</span>}
            className="mb-6"
          >
            <div className="max-h-[640px] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Case</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead>Diagnosis</TableHead>
                    <TableHead className="text-right">Conf.</TableHead>
                    <TableHead>Decided by</TableHead>
                    <TableHead className="text-right">Age</TableHead>
                    <TableHead className="text-right">Recovered</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link
                          href={`/cases/${c.id}`}
                          className="font-mono text-[11.5px] text-foreground/90 underline-offset-4 transition-colors hover:text-foreground hover:underline"
                        >
                          {c.paymentId}
                        </Link>
                      </TableCell>
                      <TableCell>{c.customerName}</TableCell>
                      <TableCell className="text-right">
                        <Money paise={c.amountPaise} />
                      </TableCell>
                      <TableCell>
                        <StatePill state={c.state} />
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-[10.5px] tracking-wide">
                        {c.diagnosis ?? "—"}
                      </TableCell>
                      <TableCell className="num text-right">
                        {c.confidence === null ? (
                          <span className="text-muted-foreground/50">—</span>
                        ) : (
                          <span
                            className={cn(
                              c.confidence < 0.6
                                ? "text-rose-300"
                                : c.confidence < 0.8
                                  ? "text-amber-300"
                                  : "text-foreground",
                            )}
                          >
                            {c.confidence.toFixed(2)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <SourceBadge source={c.decisionSource} />
                      </TableCell>
                      <TableCell className="num text-muted-foreground text-right text-xs">
                        {hours(c.hoursOpen)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {c.recoveredAmountPaise ? (
                          <Money
                            paise={c.recoveredAmountPaise}
                            className="text-emerald-300"
                          />
                        ) : (
                          <span className="text-muted-foreground/50 num">
                            —
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Panel>

          <Panel title="How these numbers are defined">
            <div className="grid gap-x-8 gap-y-4 px-4 py-4 md:grid-cols-2">
              <div>
                <p className="eyebrow">Revenue recovered</p>
                <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                  {METRIC_DEFINITIONS.moneyRecovered}
                </p>
              </div>
              <Separator className="md:hidden" />
              <div>
                <p className="eyebrow">Recovery rate</p>
                <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                  {METRIC_DEFINITIONS.recoveryRate}
                </p>
              </div>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
