// The single regex-literal escaper (devex-2026-08-17 #965), replacing three
// identical copies in tag-parser / standards / version-writer. Deliberately NOT
// `RegExp.escape` (which Bun already ships): the spec hex-encodes a leading
// alphanumeric (`RegExp.escape("bug fix")` → `\x62ug\x20fix`), so its output is
// not the plain "backslash the metacharacters" text these callers splice into
// alternations and compare/inspect as strings. This form pins the output shape;
// behavior inside `new RegExp` is identical for every input.
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
