import Link from "next/link";
import { notFound } from "next/navigation";
import { getCase } from "../../_data";
import { Money, Panel, SourceBadge, StatePill } from "../../_ui";
import { formatINR } from "@/core/domain/money";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Events that carry the most weight get a heavier rail on the timeline. */
function weight(event: string): string {
  if (event === "REVENUE_RECOVERED") return "border-foreground";
  if (event === "POLICY_BLOCKED" || event === "ACTION_FAILED") return "border-foreground/50 border-dashed";
  if (event === "AGENT_DECISION" || event === "POLICY_APPROVED") return "border-foreground/40";
  return "border-border";
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
      lines.push(`${formatINR(Number(detail.amountPaise))} confirmed via ${get("via")}`);
      lines.push(`after ${get("hoursToRecovery")}h · ref ${get("providerReference")}`);
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
    <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground text-[11px] tracking-wide uppercase self-center">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const stamp = (iso: string) => iso.replace("T", " ").slice(0, 19);

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = getCase(id);
  if (!c) notFound();

  const latest = c.decisions.at(-1);
  // The most recent link that actually got created, so a failed first attempt
  // does not hide the one the customer can pay.
  const link = c.actions.filter((a) => a.paymentLinkUrl !== null).at(-1) ?? null;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-muted-foreground mb-1 text-xs">
            <Link href="/" className="underline-offset-4 hover:underline">← All cases</Link>
            <span className="mx-1.5">·</span>
            <span className="font-mono">{c.id}</span>
          </div>
          <h1 className="font-mono text-lg font-semibold tracking-tight">{c.paymentId}</h1>
        </div>
        <div className="flex items-center gap-3">
          <StatePill state={c.state} />
          <span className="tabular text-xl font-semibold"><Money paise={c.amountPaise} /></span>
        </div>
      </header>

      {c.recoveredAmountPaise ? (
        <p className="mb-6 rounded-md border-l-2 border-l-foreground border px-3 py-2 text-xs">
          <span className="font-semibold">{formatINR(c.recoveredAmountPaise)} recovered.</span>{" "}
          Written only after the payment provider confirmed the capture — an executed intervention
          alone never counts.
        </p>
      ) : null}

      {link ? (
        <Panel
          title="Payment link"
          meta={link.provider === "razorpay_test" ? "Razorpay TEST mode" : link.provider}
          className="mb-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <a
                href={link.paymentLinkUrl!}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm underline underline-offset-4"
              >
                {link.paymentLinkUrl}
              </a>
              <p className="text-muted-foreground mt-1 font-mono text-[11px]">{link.externalRef}</p>
            </div>
            <span className="text-muted-foreground text-[11px] tracking-wide uppercase">
              {c.recoveredAmountPaise ? "paid" : "awaiting payment"}
            </span>
          </div>
          {link.provider === "razorpay_test" ? (
            <p className="text-muted-foreground border-t px-4 py-2 text-[11px]">
              A real Razorpay link in test mode. Opening it and paying with a test card marks this
              case RECOVERED on the next cycle — no real money moves.
            </p>
          ) : null}
        </Panel>
      ) : null}

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Payment">
          <Facts
            rows={[
              ["Method", c.payment.method],
              ["Failure code", <span className="font-mono text-xs">{c.payment.failureCode ?? "—"}</span>],
              ["Provider said", <span className="text-muted-foreground">{c.payment.failureReasonRaw ?? "—"}</span>],
              ["Attempt", c.payment.attemptNumber],
              ["Opened", <span className="font-mono text-xs">{stamp(c.openedAt)}</span>],
              ["Closed", <span className="font-mono text-xs">{c.closedAt ? stamp(c.closedAt) : "—"}</span>],
              ["Cycles", c.cycleCount],
            ]}
          />
        </Panel>

        <Panel title="Customer">
          <Facts
            rows={[
              ["Name", c.customer.name],
              ["Email", <span className="font-mono text-xs">{c.customer.email}</span>],
              ["Paid before", `${c.customer.successes} time(s)`],
              ["Failed before", `${c.customer.failures} time(s)`],
            ]}
          />
        </Panel>
      </div>

      {latest ? (
        <Panel title="Latest assessment" meta={<SourceBadge source={latest.source} />} className="mb-4">
          <Facts
            rows={[
              ["Diagnosis", <span className="font-mono text-xs">{latest.diagnosis}</span>],
              ["Recoverability", <span className="font-mono text-xs">{latest.recoverability}</span>],
              ["Confidence", <span className="tabular font-mono text-xs">{latest.confidence.toFixed(2)}</span>],
              ["Proposed", <span className="font-mono text-xs">{latest.action}</span>],
              ...(latest.model
                ? ([["Model", <span className="font-mono text-xs">{latest.model}</span>]] as Array<[string, React.ReactNode]>)
                : []),
            ]}
          />
          <div className="border-t px-4 py-3">
            <p className="text-sm leading-relaxed">{latest.reasoning}</p>
            {latest.source === "heuristic_fallback" ? (
              <p className="text-muted-foreground mt-2 text-[11px] tracking-wide uppercase">
                Produced by the deterministic decider, not a model
              </p>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {c.policy.length > 0 ? (
        <Panel title="Policy verdicts" meta={`${c.policy.length}`} className="mb-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 text-[11px]">Cycle</TableHead>
                  <TableHead className="h-8 text-[11px]">Proposed</TableHead>
                  <TableHead className="h-8 text-[11px]">Effective</TableHead>
                  <TableHead className="h-8 text-[11px]">Rule</TableHead>
                  <TableHead className="h-8 text-[11px]">Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.policy.map((p, i) => (
                  <TableRow key={i}>
                    <TableCell className="tabular py-1.5 text-sm">{p.cycle}</TableCell>
                    <TableCell className="py-1.5 font-mono text-[11px]">{p.originalAction}</TableCell>
                    <TableCell
                      className={cn(
                        "py-1.5 font-mono text-[11px]",
                        p.effectiveAction && p.effectiveAction !== p.originalAction && "font-semibold underline underline-offset-2",
                      )}
                    >
                      {p.effectiveAction ?? "—"}
                    </TableCell>
                    <TableCell className="py-1.5">
                      <span
                        className={cn(
                          "inline-flex rounded-sm border px-1.5 py-px font-mono text-[10px]",
                          p.approved ? "border-border" : "border-foreground/50 border-dashed",
                        )}
                      >
                        {p.ruleCode}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground w-full max-w-0 py-1.5 text-xs whitespace-normal">
                      {p.reason}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
              <div key={i} className="rounded-md border px-3 py-2">
                <div className="flex items-baseline justify-between gap-4">
                  <strong className="text-sm">{msg.subject}</strong>
                  <span className="text-muted-foreground font-mono text-[11px]">{stamp(msg.sentAt)}</span>
                </div>
                <div className="text-muted-foreground font-mono text-[11px]">to {msg.recipient}</div>
                <pre className="text-muted-foreground mt-2 font-mono text-[11px] whitespace-pre-wrap">{msg.body}</pre>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      <Panel title="Audit timeline" meta={`${c.timeline.length} entries · append-only`}>
        <ol className="space-y-0 px-4 py-3">
          {c.timeline.map((e, i) => (
            <li key={i} className={cn("flex gap-3 border-l-2 py-1.5 pl-3", weight(e.event))}>
              <span className="text-muted-foreground w-14 shrink-0 font-mono text-[11px] leading-5">
                {e.at.replace("T", " ").slice(11, 19)}
              </span>
              <div className="min-w-0">
                <span className="text-[11px] font-semibold tracking-wide uppercase">
                  {e.event.replace(/_/g, " ")}
                </span>
                {summarise(e.event, e.detail).map((line, j) => (
                  <span key={j} className="text-muted-foreground block font-mono text-[11px]">{line}</span>
                ))}
                <span className="text-muted-foreground/70 block text-[10px]">{e.actor}</span>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
