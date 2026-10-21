// Forced versions of INDIRECT libraries, read from package.json: npm/bun
// `overrides`, yarn `resolutions`, pnpm `pnpm.overrides`. A project that pins a
// vulnerable sub-dependency (D:\kb forced adm-zip/sharp/fast-uri/ip-address)
// declares those names in its manifest, just not under `dependencies` — the
// scanner read only the two dependency maps, so every `-(lib)` purpose for a
// forced library was flagged "typo or CDN?" and listed with no match.
//
// Kept apart from `libraries` on purpose: 15 consumers (client report, lib
// advisor, freshness, the vuln scan's direct list) treat that list as "what
// the project depends on directly", and a forced sub-dependency is not that.

export interface ForcedLib { name: string; version: string; eco: string }

// "a>b", "**/b", "a/@s/b", "b@<1.2" → "b" / "@s/b": the package the pin lands on.
export function overrideTarget(key: string): string {
  let k = key.trim();
  const gt = k.lastIndexOf(">");
  if (gt >= 0) k = k.slice(gt + 1);
  const parts = k.split("/").filter(p => p && p !== "**");
  if (!parts.length) return "";
  const last = parts.length >= 2 && parts[parts.length - 2].startsWith("@")
    ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
    : parts[parts.length - 1];
  // a version selector on the key ("b@<1.2", "@s/b@^2") is not part of the name
  const at = last.indexOf("@", 1);
  return at > 0 ? last.slice(0, at) : last;
}

/** Every forced library in a parsed package.json, first pin per name wins.
 *  npm nests (`{ "a": { "b": "1.0", ".": "2.0" } }` pins b, and a itself via
 *  "."); a `$name` value means "same as my direct dep" — no version of its own,
 *  skipped (the direct entry already lists it). */
export function forcedFromPackageJson(pkg: Record<string, unknown>): ForcedLib[] {
  const out: ForcedLib[] = [];
  const seen = new Set<string>();
  const push = (key: string, ver: unknown) => {
    const name = overrideTarget(key);
    if (!name || typeof ver !== "string" || !ver.trim() || ver.startsWith("$") || seen.has(name)) return;
    seen.add(name);
    out.push({ name, version: ver.trim(), eco: "npm" });
  };
  const walk = (map: unknown) => {
    if (!map || typeof map !== "object" || Array.isArray(map)) return;
    for (const [key, val] of Object.entries(map as Record<string, unknown>)) {
      if (val && typeof val === "object") {
        const self = (val as Record<string, unknown>)["."];
        if (self !== undefined) push(key, self);
        walk(Object.fromEntries(Object.entries(val as Record<string, unknown>).filter(([k]) => k !== ".")));
      } else push(key, val);
    }
  };
  walk(pkg.overrides);
  walk(pkg.resolutions);
  walk((pkg.pnpm as Record<string, unknown> | undefined)?.overrides);
  return out;
}
