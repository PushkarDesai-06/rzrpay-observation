"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { runCycle, simulateFailure, type ActionOutcome } from "./_actions";

/**
 * The two controls that make the loop watchable: put a failure in, and let the
 * agent take its next turn. Both call server actions, so the browser never
 * reaches a repository.
 */
export function Controls() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionOutcome | null>(null);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form
          action={(fd) => start(async () => setResult(await simulateFailure(fd)))}
          className="flex items-center gap-2"
        >
          <Input
            name="amount"
            type="number"
            min="1"
            step="1"
            defaultValue="2499"
            aria-label="Amount in rupees"
            className="h-8 w-28 tabular text-sm"
          />
          <Select name="reason" defaultValue="TRANSIENT">
            <SelectTrigger className="h-8 w-[190px] text-sm" aria-label="Failure reason">
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
        >
          {pending ? "Running…" : "Run cycle"}
        </Button>
      </div>

      {result ? (
        <p
          className={`text-xs ${result.ok ? "text-muted-foreground" : "text-foreground font-medium"}`}
          role="status"
        >
          {result.ok ? "" : "Failed — "}
          {result.message}
        </p>
      ) : null}
    </div>
  );
}
