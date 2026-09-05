"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { runCycle, simulateFailure, type ActionOutcome } from "./_actions";
import { cn } from "@/lib/utils";

/**
 * The two controls that make the loop watchable: put a failure in, and let the
 * agent take its next turn. Both call server actions, so the browser never
 * reaches a repository.
 */
export function Controls() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionOutcome | null>(null);

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form
          action={(fd) => start(async () => setResult(await simulateFailure(fd)))}
          className="flex items-center gap-1.5 rounded-lg border border-white/6 bg-white/2 p-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]"
        >
          <div className="relative">
            <span className="text-muted-foreground/70 pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 font-mono text-xs">
              ₹
            </span>
            <Input
              name="amount"
              type="number"
              min="1"
              step="1"
              defaultValue="2499"
              aria-label="Amount in rupees"
              className="num h-8 w-28 pl-6 text-[13px]"
            />
          </div>
          <Select name="reason" defaultValue="TRANSIENT">
            <SelectTrigger className="h-8 w-[190px] text-[13px]" size="sm" aria-label="Failure reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="TRANSIENT">Issuer unavailable</SelectItem>
              <SelectItem value="CVV">Incorrect CVV</SelectItem>
              <SelectItem value="FUNDS">Insufficient funds</SelectItem>
              <SelectItem value="EXPIRED">Card expired</SelectItem>
              <SelectItem value="TIMEOUT">Gateway timeout</SelectItem>
              <SelectItem value="AMBIGUOUS">Ambiguous decline</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Simulate failure
          </Button>
        </form>

        <Button
          size="sm"
          disabled={pending}
          onClick={() => start(async () => setResult(await runCycle()))}
          className="min-w-[104px]"
        >
          {pending ? "Running…" : "Run cycle"}
        </Button>
      </div>

      {result ? (
        <p
          className={cn(
            "flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11.5px] leading-4",
            result.ok
              ? "border-white/6 bg-white/2 text-muted-foreground"
              : "border-rose-400/20 bg-rose-500/10 text-rose-200",
          )}
          role="status"
        >
          <span className="num">{result.ok ? "" : "Failed — "}{result.message}</span>
        </p>
      ) : null}
    </div>
  );
}
