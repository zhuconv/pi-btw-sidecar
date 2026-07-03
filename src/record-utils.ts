/**
 * Shared record narrowing utility.
 *
 * Consolidates the per-module `isRecord` type guards that were duplicated across
 * `btw-runtime-core.ts`, `btw-runtime.ts`, `config.ts`, and `icons.ts`.
 *
 * A record is a non-null, non-array object. Arrays are intentionally excluded
 * because they are not string-keyed records and every call site only accesses
 * string-keyed properties (which are `undefined` on arrays), so rejecting arrays
 * is observably equivalent to the previous permissive variant in `icons.ts`.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
