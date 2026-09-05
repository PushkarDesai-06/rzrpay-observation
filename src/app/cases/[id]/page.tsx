import Link from "next/link";
import { notFound } from "next/navigation";
import { getCase } from "../../_data";
import {
  Money,
  Panel,
  PanelNote,
  RuleTag,
  SourceBadge,
  StatePill,
} from "../../_ui";
import { formatINR } from "@/core/domain/money";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/*
 * Timeline rails share the console's state palette: emerald for money, rose
 * for a refusal or failure, violet for the decider, sky for a verdict that let
 * the action through. Everything else is neutral.
 */
function rail(event: string): { line: string; dot: string } {
  if (event === "REVENUE_RECOVERED") {
    return {
      line: "border-emerald-400/60",
      dot: "bg-emerald-400 shadow-[0_0_8px_1px_var(--color-emerald-400)]",
    };
  }
  if (event === "POLICY_BLOCKED" || event === "ACTION_FAILED") {
    return {
      line: "border-rose-400/50",
      dot: "bg-rose-400 shadow-[0_0_8px_1px_var(--color-rose-400)]",
    };
  }
  if (event === "AGENT_DECISION") {
    return {
      line: "border-violet-400/50",
      dot: "bg-violet-400 shadow-[0_0_8px_1px_var(--color-violet-400)]",
    };
  }
  if (event === "POLICY_APPROVED") {
    return {
      line: "border-sky-400/50",
      dot: "bg-sky-400 shadow-[0_0_8px_1px_var(--color-sky-400)]",
    };
  }
  return { line: "border-white/10", dot: "bg-white/30" };
}

function summarise(event: string, detail: Record<string, unknown>): string[] {
  const get = (k: string): string | null => {
    const v = detail[k];
    return v === undefined || v === null ? null : String(v);
  };
  const lines: string[] = [];

  switch (event) {
    case "AGENT_DECISION":
      lines.push(
        `${get("diagnosis")} · ${get("recoverability")} · confidence ${Number(detail.confidence).toFixed(2)}`,
      );
      lines.push(`proposes ${get("recommendedAction")}`);
      break;
    case "POLICY_APPROVED":
    case "POLICY_BLOCKED": {
      const proposed = get("proposed");
      const effective = get("effective");
      lines.push(
        detail.overridden === true
          ? `${proposed} → ${effective}  (overridden)`
          : `${effective ?? proposed} · ${get("outcome")}`,
      );
      lines.push(`${get("rule")}`);
      break;
    }
    case "ACTION_SUCCEEDED":
    case "ACTION_FAILED":
    case "ACTION_EXECUTING":
      lines.push(`${get("action")} via ${get("provider")}`);
      if (get("externalRef")) lines.push(`ref ${get("externalRef")}`);
      if (get("error")) lines.push(`error: ${get("error")}`);
      break;
    case "STATE_TRANSITION":
      lines.push(`${get("from")} → ${get("to")}`);
      break;
    case "REVENUE_RECOVERED":
      lines.push(
        `${formatINR(Number(detail.amountPaise))} confirmed via ${get("via")}`,
      );
      lines.push(
        `after ${get("hoursToRecovery")}h · ref ${get("providerReference")}`,
      );
      break;
    case "CASE_CREATED":
      lines.push(`${formatINR(Number(detail.amountPaise))} at risk`);
      break;
    default:
      break;
  }
  return lines;
}

function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="divide-y divide-white/5 px-4 text-[13px]">
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="grid grid-cols-[130px_1fr] items-center gap-x-4 py-2"
        >
          <dt className="eyebrow">{k}</dt>
          <dd className="min-w-0 break-words text-foreground/90">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const stamp = (iso: string) => iso.replace("T", " ").slice(0, 19);
const Code = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string | undefined;
}) => <span className={cn("num text-xs", className)}>{children}</span>;

export default async function CasePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const c = getCase(id);
  if (!c) notFound();

  const latest = c.decisions.at(-1);
  // The most recent link that actually got created, so a failed first attempt
  // does not hide the one the customer can pay.
  const link =
    c.actions.filter((a) => a.paymentLinkUrl !== null).at(-1) ?? null;

  return (
    <div className="mx-auto max-w-[1240px] px-6 py-7">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <nav className="text-muted-foreground mb-2 flex items-center gap-1.5 text-xs">
            <Link href="/" className="transition-colors hover:text-foreground">
              Overview
            </Link>
            <span className="text-muted-foreground/40">/</span>
            <span className="font-mono text-[11.5px]">{c.id}</span>
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-[20px] font-semibold tracking-tight">
              {c.paymentId}
            </h1>
            <StatePill state={c.state} />
          </div>
        </div>
        <div className="text-right">
          <p className="eyebrow">Amount at risk</p>
          <p className="num mt-1 text-[26px] leading-none font-semibold tracking-tight">
            <Money paise={c.amountPaise} />
          </p>
        </div>
      </header>

      {c.recoveredAmountPaise ? (
        <div className="mb-6 rounded-lg border border-emerald-400/20 bg-emerald-500/7 px-4 py-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
          <p className="text-[13px] leading-relaxed text-emerald-100/90">
            <span className="num font-semibold text-emerald-200">
              {formatINR(c.recoveredAmountPaise)} recovered.
            </span>{" "}
            Written only after the payment provider confirmed the capture — an
            executed intervention alone never counts.
          </p>
        </div>
      ) : null}

      {link ? (
        <Panel
          title="Payment link"
          meta={
            <Badge
              variant={link.provider === "razorpay_test" ? "sky" : "slate"}
              className="uppercase"
            >
              {link.provider === "razorpay_test"
                ? "Razorpay test mode"
                : link.provider}
            </Badge>
          }
          className="mb-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <a
                href={link.paymentLinkUrl!}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[13px] text-sky-300 underline-offset-4 transition-colors hover:text-sky-200 hover:underline"
              >
                {link.paymentLinkUrl}
              </a>
              <p className="text-muted-foreground mt-1 font-mono text-[11px]">
                {link.externalRef}
              </p>
            </div>
            <Badge
              variant={c.recoveredAmountPaise ? "emerald" : "amber"}
              className="uppercase"
            >
              {c.recoveredAmountPaise ? "paid" : "awaiting payment"}
            </Badge>
          </div>
        </Panel>
      ) : null}

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Payment">
          <Facts
            rows={[
              ["Method", c.payment.method],
              ["Failure code", <Code>{c.payment.failureCode ?? "—"}</Code>],
              [
                "Provider said",
                <span className="text-muted-foreground">
                  {c.payment.failureReasonRaw ?? "—"}
                </span>,
              ],
              ["Attempt", <Code>{c.payment.attemptNumber}</Code>],
              ["Opened", <Code>{stamp(c.openedAt)}</Code>],
              ["Closed", <Code>{c.closedAt ? stamp(c.closedAt) : "—"}</Code>],
              ["Cycles", <Code>{c.cycleCount}</Code>],
            ]}
          />
        </Panel>

        <Panel title="Customer">
          <Facts
            rows={[
              ["Name", c.customer.name],
              ["Email", <Code>{c.customer.email}</Code>],
              [
                "Paid before",
                <Code
                  className={
                    c.customer.successes > 0 ? "text-emerald-300" : undefined
                  }
                >
                  {c.customer.successes} time(s)
                </Code>,
              ],
              [
                "Failed before",
                <Code
                  className={
                    c.customer.failures > 0 ? "text-rose-300" : undefined
                  }
                >
                  {c.customer.failures} time(s)
                </Code>,
              ],
            ]}
          />
        </Panel>
      </div>

      {latest ? (
        <Panel
          title="Latest assessment"
          meta={<SourceBadge source={latest.source} />}
          className="mb-4"
        >
          <div className="grid gap-x-6 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ["Diagnosis", latest.diagnosis, undefined],
                ["Recoverability", latest.recoverability, undefined],
                [
                  "Confidence",
                  latest.confidence.toFixed(2),
                  latest.confidence < 0.6
                    ? "text-rose-300"
                    : latest.confidence < 0.8
                      ? "text-amber-300"
                      : "text-emerald-300",
                ],
                ["Proposed", latest.action, undefined],
              ] as Array<[string, string, string | undefined]>
            ).map(([k, v, tone]) => (
              <div key={k} className="py-1.5">
                <p className="eyebrow">{k}</p>
                <p className={cn("num mt-1 text-[13px] font-medium", tone)}>
                  {v}
                </p>
              </div>
            ))}
          </div>
          <div className="border-t border-white/6 px-4 py-3">
            <p className="text-[13px] leading-relaxed text-foreground/85">
              {latest.reasoning}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {latest.model ? (
                <span className="text-muted-foreground font-mono text-[11px]">
                  {latest.model}
                </span>
              ) : null}
              {latest.latencyMs !== null ? (
                <span className="text-muted-foreground/70 num text-[11px]">
                  {latest.latencyMs} ms
                </span>
              ) : null}
              {latest.source === "heuristic_fallback" ? (
                <span className="eyebrow">
                  Produced by the deterministic decider, not a model
                </span>
              ) : null}
            </div>
          </div>
        </Panel>
      ) : null}

      {c.policy.length > 0 ? (
        <Panel
          title="Policy verdicts"
          meta={`${c.policy.length}`}
          className="mb-4"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Cycle</TableHead>
                <TableHead>Proposed</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.policy.map((p, i) => {
                const overridden =
                  p.effectiveAction !== null &&
                  p.effectiveAction !== p.originalAction;
                return (
                  <TableRow key={i}>
                    <TableCell className="num text-muted-foreground">
                      {p.cycle}
                    </TableCell>
                    <TableCell className="font-mono text-[11.5px]">
                      {p.originalAction}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "font-mono text-[11.5px]",
                        overridden && "font-semibold text-amber-300",
                      )}
                    >
                      {p.effectiveAction ?? "—"}
                      {overridden ? (
                        <span className="text-amber-300/60 ml-1.5 text-[10px] uppercase tracking-wide">
                          overridden
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <RuleTag code={p.ruleCode} approved={p.approved} />
                    </TableCell>
                    <TableCell className="text-muted-foreground w-full max-w-0 text-xs leading-relaxed whitespace-normal">
                      {p.reason}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Panel>
      ) : null}

      {c.messages.length > 0 ? (
        <Panel
          title="Messages sent"
          meta={`transport: ${c.messages[0]!.transport} — not delivered to a real inbox`}
          className="mb-4"
        >
          <div className="space-y-3 px-4 py-3">
            {c.messages.map((msg, i) => (
              <div
                key={i}
                className="rounded-md border border-white/6 bg-white/2 px-3.5 py-3 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]"
              >
                <div className="flex items-baseline justify-between gap-4">
                  <strong className="text-[13px] font-semibold">
                    {msg.subject}
                  </strong>
                  <span className="text-muted-foreground num text-[11px]">
                    {stamp(msg.sentAt)}
                  </span>
                </div>
                <div className="text-muted-foreground mt-0.5 font-mono text-[11px]">
                  to {msg.recipient}
                </div>
                <pre className="text-muted-foreground mt-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                  {msg.body}
                </pre>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel
        title="Audit timeline"
        meta={`${c.timeline.length} entries · append-only`}
      >
        <ol className="px-4 py-3">
          {c.timeline.map((e, i) => {
            const r = rail(e.event);
            return (
              <li
                key={i}
                className={cn("relative flex gap-4 border-l py-2 pl-5", r.line)}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-[15px] -left-[3.5px] size-1.5 rounded-full",
                    r.dot,
                  )}
                />
                <span className="text-muted-foreground num w-16 shrink-0 text-[11px] leading-5">
                  {e.at.replace("T", " ").slice(11, 19)}
                </span>
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold tracking-wider uppercase text-foreground/90">
                    {e.event.replace(/_/g, " ")}
                  </span>
                  {summarise(e.event, e.detail).map((line, j) => (
                    <span
                      key={j}
                      className="text-muted-foreground block font-mono text-[11px] leading-5"
                    >
                      {line}
                    </span>
                  ))}
                  <span className="text-muted-foreground/50 block text-[10px]">
                    {e.actor}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>
    </div>
  );
}
