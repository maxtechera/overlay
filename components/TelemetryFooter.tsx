"use client";

/**
 * components/TelemetryFooter.tsx — TECH-SPEC §5: per-turn "4.2k in / 890 out · 6.1s" footer,
 * plus cache-read tokens (visible proof of prompt caching from the 2nd turn on).
 */

import type { Telemetry } from "@/lib/store";

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function TelemetryFooter({ telemetry }: { telemetry: Telemetry[] }) {
  const last = telemetry.at(-1);
  if (!last) return null;

  return (
    <div className="border-t px-3 py-1.5 font-mono text-[11px] text-muted-foreground" data-testid="telemetry-footer">
      {fmt(last.tokensIn)} in / {fmt(last.tokensOut)} out
      {last.cacheReadTokens > 0 && <span data-testid="cache-read-tokens"> · {fmt(last.cacheReadTokens)} cached</span>}
      {" · "}
      {(last.ms / 1000).toFixed(1)}s
    </div>
  );
}
