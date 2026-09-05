import { formatINR } from "@/core/domain/money";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/*
 * Hue carries state, and only state.
 *
 *   emerald  money confirmed
 *   amber    the loop still owns the case and is acting on it
 *   sky      the loop is waiting on something outside itself
 *   rose     a person has to look at it
 *   slate    closed without the money
 *
 * The same palette is used by every badge on the console so a colour means the
 * same thing in a table cell, a header and a timeline rail.
 */
const STATE_TONE: Record<string, BadgeVariant> = {
  RECOVERED: "emerald",
  DETECTED: "amber",
  ANALYZING: "amber",
  RECOVERY_CANDIDATE: "amber",
  ACTION_PLANNED: "amber",
  POLICY_VALIDATED: "amber",
  ACTION_EXECUTING: "amber",
  WAITING_FOR_OUTCOME: "sky",
  ESCALATED: "rose",
  FAILED: "rose",
  BLOCKED_BY_POLICY: "slate",
  NOT_RECOVERABLE: "slate",
  STOPPED: "slate",
};

export function StatePill({ state, className }: { state: string; className?: string }) {
  const variant = STATE_TONE[state] ?? "slate";
  return (
    <Badge variant={variant} className={cn("uppercase", className)}>
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
    return <span className="text-muted-foreground/60 text-[11px]">—</span>;
  }
  const label = source === "llm" ? "model" : source === "heuristic_fallback" ? "rules" : source;
  return (
    <Badge
      variant={source === "llm" ? "violet" : "slate"}
      className="uppercase"
      title={source === "llm" ? "Produced by the model" : "Produced by the deterministic decider"}
    >
      {label}
    </Badge>
  );
}

/** Policy rule code, coloured by whether the rule let the action through. */
export function RuleTag({ code, approved }: { code: string; approved: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-px font-mono text-[10.5px] tracking-wide ring-1 ring-inset",
        approved
          ? "bg-white/4 text-muted-foreground ring-white/8"
          : "bg-rose-500/10 text-rose-300 ring-rose-400/20",
      )}
    >
      {code}
    </span>
  );
}

export function Money({
  paise,
  className,
}: {
  paise: number | null | undefined;
  className?: string;
}) {
  return <span className={cn("num", className)}>{formatINR(paise ?? 0)}</span>;
}

/**
 * Inline sparkline drawn from real series data. Renders nothing for fewer than
 * two points rather than inventing a shape.
 */
export function Sparkline({
  points,
  className,
  tone = "emerald",
}: {
  points: readonly number[];
  className?: string;
  tone?: "emerald" | "amber" | "rose" | "sky" | "slate";
}) {
  if (points.length < 2) return null;
  const w = 96;
  const h = 28;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => [Math.min(i * step, w - 2.5), h - 2 - ((p - min) / span) * (h - 4)] as const);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const stroke = {
    emerald: "stroke-emerald-400",
    amber: "stroke-amber-400",
    rose: "stroke-rose-400",
    sky: "stroke-sky-400",
    slate: "stroke-slate-400",
  }[tone];
  const fill = {
    emerald: "fill-emerald-400/15",
    amber: "fill-amber-400/15",
    rose: "fill-rose-400/15",
    sky: "fill-sky-400/15",
    slate: "fill-slate-400/15",
  }[tone];
  const last = coords.at(-1)!;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-7 w-full min-w-0 max-w-24 flex-1", className)}
      aria-hidden
    >
      <path d={area} className={fill} />
      <path d={line} fill="none" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className={stroke} />
      <circle cx={last[0]} cy={last[1]} r={2} className={cn(stroke, "fill-[#0e1117]")} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Proportional meter. `value` is a 0–1 ratio; the fill hue follows the KPI so
 * a recovery-rate meter reads emerald and an at-risk meter reads amber.
 */
export function Meter({
  value,
  tone = "emerald",
  className,
}: {
  value: number;
  tone?: "emerald" | "amber" | "rose" | "sky" | "slate";
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const bar = {
    emerald: "bg-emerald-400",
    amber: "bg-amber-400",
    rose: "bg-rose-400",
    sky: "bg-sky-400",
    slate: "bg-slate-400",
  }[tone];
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-white/6", className)} aria-hidden>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", bar)}
        style={{ width: `${pct}%`, boxShadow: "0 0 8px 0 currentColor", opacity: 0.9 }}
      />
    </div>
  );
}

export function Kpi({
  label,
  value,
  note,
  tone = "slate",
  trend,
  spark,
  meter,
  className,
}: {
  label: string;
  value: string;
  /** Secondary line in mono. Counts, medians, and amounts belong here. */
  note?: React.ReactNode;
  tone?: "emerald" | "amber" | "rose" | "sky" | "slate";
  /** Small qualifier rendered as a badge beside the value. */
  trend?: { label: string; variant: BadgeVariant } | undefined;
  spark?: readonly number[] | undefined;
  /** 0–1 ratio drawn as a thin meter beneath the value. */
  meter?: number | undefined;
  className?: string;
}) {
  return (
    <Card className={cn("gap-0 rounded-lg py-0", className)}>
      <CardContent className="flex h-full flex-col px-4 pt-3.5 pb-3">
        <p className="eyebrow">{label}</p>
        <div className="mt-2 flex items-end justify-between gap-3">
          <p className="num shrink-0 text-[22px] leading-none font-semibold tracking-tight text-foreground">
            {value}
          </p>
          {spark ? <Sparkline points={spark} tone={tone} /> : null}
          {trend ? <Badge variant={trend.variant}>{trend.label}</Badge> : null}
        </div>
        {meter !== undefined ? <Meter value={meter} tone={tone} className="mt-3" /> : null}
        {note ? (
          <p className="text-muted-foreground mt-2 num text-[11px] leading-4">{note}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Section wrapper. Elevated surface with a labelled header and optional right-hand meta. */
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
    <section className={cn("surface overflow-hidden rounded-lg", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-white/6 bg-white/1.5 px-4 py-2.5">
        <h2 className="text-[13px] font-semibold tracking-tight">{title}</h2>
        {meta ? (
          <div className="text-muted-foreground flex items-center gap-2 num text-[11px]">{meta}</div>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** Footnote strip beneath a panel body. */
export function PanelNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-muted-foreground border-t border-white/6 bg-white/1 px-4 py-2 text-[11px] leading-relaxed">
      {children}
    </p>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        "rounded-[4px] bg-white/5 px-1 py-px font-mono text-[11px] text-foreground/90 ring-1 ring-inset ring-white/6",
        className,
      )}
    >
      {children}
    </code>
  );
}

/** Small key/value chip for runtime facts in the shell header. */
export function Chip({ k, v }: { k: string; v: string }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-white/8 bg-white/3 px-2 text-[11px] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <span className="text-muted-foreground/80 font-medium tracking-wide uppercase">{k}</span>
      <span className="font-mono text-foreground/90">{v}</span>
    </span>
  );
}
