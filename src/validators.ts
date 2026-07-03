// Tiny, dependency-free request-body validators (plan fable/round2 task 3.2).
// The route handlers used to read an untyped `body: any` (or an `as {...}` cast
// that lies at runtime) and reach for fields ad-hoc. These helpers turn an
// unknown parsed body into typed, bounded access at the API boundary: each
// extractor NEVER throws — it returns a safe fallback for a missing/wrong-typed
// field — so a malformed payload degrades to defaults (and the handler's own
// not-found / required-field checks) instead of a 500.
//
// Usage:
//   const body = obj(await req.json());
//   const cwd  = str(body.cwd);
//   const n    = int(body.count, 5, { min: 1, max: 100 });
//
// For a field that MUST be present, use the handler's existing guard on the
// returned value (e.g. `if (!sessionId) return 400`).

/** Coerce to a plain object. Arrays and non-objects → {} (fields then fall back). */
export function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A string field, or `fallback` if absent/non-string. */
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** A finite number field, or `fallback`. Optional clamp via {min,max}. */
export function num(v: unknown, fallback = 0, clamp?: { min?: number; max?: number }): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return applyClamp(n, clamp);
}

/** A finite integer field, or `fallback`. Accepts a numeric string too (query
 *  params arrive as strings). Optional clamp via {min,max}. */
export function int(v: unknown, fallback = 0, clamp?: { min?: number; max?: number }): number {
  let n: number;
  if (typeof v === "number" && Number.isFinite(v)) n = Math.trunc(v);
  else if (typeof v === "string" && /^-?\d+$/.test(v.trim())) n = parseInt(v, 10);
  else n = fallback;
  return applyClamp(n, clamp);
}

/** A strict boolean — true only for the literal `true` (mirrors the existing
 *  `x === true` idiom; a truthy string/number is NOT coerced). */
export function bool(v: unknown): boolean {
  return v === true;
}

/** An array field, or [] if absent/non-array. */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function applyClamp(n: number, clamp?: { min?: number; max?: number }): number {
  if (!clamp) return n;
  if (typeof clamp.min === "number") n = Math.max(clamp.min, n);
  if (typeof clamp.max === "number") n = Math.min(clamp.max, n);
  return n;
}
