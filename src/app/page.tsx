import Link from "next/link";
import { getMetrics, listCases, listEscalations } from "./_data";
import { getRuntime } from "./_runtime";
import { Controls } from "./_controls";
import { Kpi, Money, Mono, Panel, SourceBadge, StatePill } from "./_ui";
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

// Reads live from SQLite on every request; never prerendered at build time.
export const dynamic = "force-dynamic";

export default function Dashboard() {
  const m = getMetrics();
  const cases = listCases();
  const escalations = listEscalations();
  const { decider, provider } = getRuntime();

  const hours = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}h`);
  const escalatedPaise = escalations.reduce((sum, e) => sum + e.amountPaise, 0);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Recovery Console
          </h1>
        </div>
        <Controls />
      </header>

      {m.cases.total === 0 ? (
        <Panel title="No cases yet">
          <div className="text-muted-foreground px-4 py-10 text-center text-sm">
            <p>Nothing has failed yet.</p>
            <p className="mt-1">
              Simulate a failure above, or run <Mono>npm run seed</Mono> for a
              full book.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Kpi
              label="At risk"
              value={formatINR(m.revenue.atRiskPaise)}
              note={`${m.cases.open} open`}
            />
            <Kpi
              label="Recovered"
              value={formatINR(m.revenue.recoveredPaise)}
              note="confirmed captures"
            />
            <Kpi
              label="Recovery rate"
              value={formatRate(m.rates.recoveryRate)}
              note="of intervened cases"
            />
            <Kpi
              label="Avg to recover"
              value={hours(m.timing.averageHoursToRecovery)}
              note={`median ${hours(m.timing.medianHoursToRecovery)}`}
            />
            <Kpi
              label="Escalations"
              value={String(m.cases.escalated)}
              note={formatINR(escalatedPaise)}
            />
            <Kpi
              label="Policy blocks"
              value={String(m.policy.blocked)}
              note={`${m.policy.overridden} overridden`}
            />
          </div>

          {escalations.length > 0 ? (
            <Panel
              title="Waiting on a human"
              meta={`${escalations.length} ${escalations.length <= 1 ? "case" : "cases"} · ${formatINR(escalatedPaise)}`}
              className="mb-6"
            >
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8 text-[11px]">Case</TableHead>
                    <TableHead className="h-8 text-[11px]">Customer</TableHead>
                    <TableHead className="h-8 text-right text-[11px]">
                      Amount
                    </TableHead>
                    <TableHead className="h-8 text-[11px]">
                      Why it escalated
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {escalations.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="py-2">
                        <Link
                          href={`/cases/${e.id}`}
                          className="font-mono text-[11px] underline-offset-4 hover:underline"
                        >
                          {e.paymentId}
                        </Link>
                      </TableCell>
                      <TableCell className="py-2 text-sm">
                        {e.customerName}
                      </TableCell>
                      <TableCell className="py-2 text-right text-sm font-medium">
                        <Money paise={e.amountPaise} />
                      </TableCell>
                      {/* Reasons are full sentences; the table default would clip them. */}
                      <TableCell className="w-full max-w-0 py-2 whitespace-normal">
                        <div className="font-mono text-[10px] tracking-wide uppercase">
                          {e.ruleCode}
                        </div>
                        <div className="text-muted-foreground mt-0.5 text-xs">
                          {e.reason}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-muted-foreground border-t px-4 py-2 text-[11px]">
                <span className="text-foreground font-medium">Read-only.</span>{" "}
                ESCALATED is a terminal state, so there is no legal transition
                back into the loop — resolving these from here needs a
                state-machine change, not just a button.
              </p>
            </Panel>
          ) : null}

          <div className="mb-6 grid gap-4 lg:grid-cols-2">
            <Panel title="Interventions" meta="proposed → run → succeeded">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8 text-[11px]">Action</TableHead>
                    <TableHead className="h-8 text-right text-[11px]">
                      Proposed
                    </TableHead>
                    <TableHead className="h-8 text-right text-[11px]">
                      Run
                    </TableHead>
                    <TableHead className="h-8 text-right text-[11px]">
                      Succeeded
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {m.actions
                    .filter((a) => a.proposed > 0 || a.attempted > 0)
                    .map((a) => (
                      <TableRow key={a.action}>
                        <TableCell className="py-1.5 font-mono text-[11px]">
                          {a.action}
                        </TableCell>
                        <TableCell className="tabular py-1.5 text-right text-sm">
                          {a.proposed}
                        </TableCell>
                        <TableCell className="tabular py-1.5 text-right text-sm">
                          {a.attempted}
                        </TableCell>
                        <TableCell className="tabular py-1.5 text-right text-sm font-medium">
                          {a.succeeded}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </Panel>

            <Panel title="Why actions were blocked" meta="policy rule">
              {m.policy.blocksByRule.length === 0 ? (
                <p className="text-muted-foreground px-4 py-8 text-center text-sm">
                  No actions were blocked.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="h-8 text-[11px]">Rule</TableHead>
                      <TableHead className="h-8 text-right text-[11px]">
                        Blocks
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.policy.blocksByRule.map((b) => (
                      <TableRow key={b.ruleCode}>
                        <TableCell className="py-1.5 font-mono text-[11px]">
                          {b.ruleCode}
                        </TableCell>
                        <TableCell className="tabular py-1.5 text-right text-sm">
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
            meta={`${cases.length} shown`}
            className="mb-6"
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-8 text-[11px]">Case</TableHead>
                    <TableHead className="h-8 text-[11px]">Customer</TableHead>
                    <TableHead className="h-8 text-right text-[11px]">
                      Amount
                    </TableHead>
                    <TableHead className="h-8 text-[11px]">State</TableHead>
                    <TableHead className="h-8 text-[11px]">Diagnosis</TableHead>
                    <TableHead className="h-8 text-right text-[11px]">
                      Conf.
                    </TableHead>
                    <TableHead className="h-8 text-[11px]">
                      Decided by
                    </TableHead>
                    <TableHead className="h-8 text-right text-[11px]">
                      Recovered
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cases.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="py-1.5">
                        <Link
                          href={`/cases/${c.id}`}
                          className="font-mono text-[11px] underline-offset-4 hover:underline"
                        >
                          {c.paymentId}
                        </Link>
                      </TableCell>
                      <TableCell className="py-1.5 text-sm">
                        {c.customerName}
                      </TableCell>
                      <TableCell className="py-1.5 text-right text-sm">
                        <Money paise={c.amountPaise} />
                      </TableCell>
                      <TableCell className="py-1.5">
                        <StatePill state={c.state} />
                      </TableCell>
                      <TableCell className="text-muted-foreground py-1.5 font-mono text-[10px]">
                        {c.diagnosis ?? "—"}
                      </TableCell>
                      <TableCell className="tabular py-1.5 text-right text-sm">
                        {c.confidence === null ? "—" : c.confidence.toFixed(2)}
                      </TableCell>
                      <TableCell className="py-1.5">
                        <SourceBadge source={c.decisionSource} />
                      </TableCell>
                      <TableCell className="py-1.5 text-right text-sm font-medium">
                        {c.recoveredAmountPaise ? (
                          formatINR(c.recoveredAmountPaise)
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Panel>

          <Panel title="How these numbers are defined">
            <div className="space-y-3 px-4 py-3">
              <div>
                <p className="text-[11px] tracking-wide uppercase">
                  Revenue recovered
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {METRIC_DEFINITIONS.moneyRecovered}
                </p>
              </div>
              <Separator />
              <div>
                <p className="text-[11px] tracking-wide uppercase">
                  Recovery rate
                </p>
                <p className="text-muted-foreground mt-0.5 text-xs">
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
