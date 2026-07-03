/**
 * Shared BTW token-usage helpers.
 *
 * Consolidates `getNumericUsageField` and `formatBtwUsage`, which were duplicated
 * across `btw-runtime-core.ts` (used by usage normalization) and `btw-runtime.ts`
 * (used by the BTW note message renderer). Keeping them in one module avoids the
 * cross-file copy-paste clones detected by the solution-quality validator while
 * staying lightweight so the entry point can import it without loading the heavy
 * runtime core.
 */

import { isRecord } from "./record-utils";

export function getNumericUsageField(usage: unknown, fieldNames: string[]): number | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }

  for (const fieldName of fieldNames) {
    const value = usage[fieldName];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }

  return undefined;
}

export function formatBtwUsage(usage: unknown): string | null {
  const input = getNumericUsageField(usage, ["input", "inputTokens", "promptTokens", "prompt_tokens"]);
  const output = getNumericUsageField(usage, ["output", "outputTokens", "completionTokens", "completion_tokens"]);
  const cacheRead = getNumericUsageField(usage, ["cacheRead", "cache_read", "cachedTokens", "cached_tokens"]);
  const cacheWrite = getNumericUsageField(usage, ["cacheWrite", "cache_write"]);
  const total =
    getNumericUsageField(usage, ["totalTokens", "total", "total_tokens"]) ??
    (input !== undefined || output !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
      : undefined);

  if (input === undefined && output === undefined && total === undefined) {
    return null;
  }

  return `tokens: in ${input ?? "?"} · out ${output ?? "?"} · total ${total ?? "?"}`;
}
