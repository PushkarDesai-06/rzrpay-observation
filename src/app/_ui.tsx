import { formatINR } from "@/core/domain/money";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * State carried by fill weight rather than hue.
 *
 * Solid means settled and good, outline means the loop still owns it, muted
 * means closed without the money. Keeping this monochrome stops the table from
 * implying a severity the data has not established.
 */
export function StatePill({ state }: { state: string }) {
  const variant =
    state === "RECOVERED"
      ? "default"
      : state === "ESCALATED"
        ? "outline"
        : ["FAILED", "NOT_RECOVERABLE", "STOPPED"].includes(state)
          ? "secondary"
          : "outline";

  return (
    <Badge
      variant={variant}
      className={cn(
        "rounded-sm px-1.5 py-0 text-[10px] font-medium tracking-wide uppercase",
        state === "ESCALATED" && "border-foreground/60 border-dashed",
        ["FAILED", "NOT_RECOVERABLE", "STOPPED"].includes(state) && "text-muted-foreground",
      )}
    >
      {state.replace(/_/g, " ")}
    </Badge>
  );
}

/**
 * Which decider produced a decision.
 *
 * Shown everywhere a decision appears. A deterministic fallback must never be
 * mistaken for model reasoning by someone reading the case.
 */
export function SourceBadge({ source }: { source: string | null }) {
  if (!source) {
    return <span className="text-muted-foreground text-[11px]">—</span>;
  }
  const label = source === "llm" ? "model" : source === "heuristic_fallback" ? "rules" : source;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-1.5 py-px text-[10px] tracking-wide uppercase",
        source === "llm"
          ? "border-foreground/30 text-foreground"
          : "border-border text-muted-foreground border-dashed",
      )}
      title={source === "llm" ? "Produced by the model" : "Produced by the deterministic decider"}
    >
      {label}
    </span>
  );
}

export function Money({ paise }: { paise: number | null | undefined }) {
  return <span className="tabular">{formatINR(paise ?? 0)}</span>;
}

export function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <Card className="rounded-md py-0 shadow-none">
      <CardContent className="px-4 py-3">
        <p className="text-muted-foreground text-[11px] tracking-wide uppercase">{label}</p>
        <p className="tabular mt-1 text-xl font-semibold tracking-tight">{value}</p>
        {note ? <p className="text-muted-foreground mt-0.5 text-[11px]">{note}</p> : null}
      </CardContent>
    </Card>
  );
}

/** Section wrapper. Plain border, no elevation — this is a report, not a deck. */
export function Panel({
  title,
  meta,
  children,
  className,
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-card rounded-md border", className)}>
      <header className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {meta ? <div className="text-muted-foreground text-[11px]">{meta}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11px]">{children}</span>;
}
