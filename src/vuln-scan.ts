// Dependency vulnerability + freshness scan for one project, extracted from the
// server's route layer (report fable/index.html #3) so this ~230-line pipeline is
// unit-testable in isolation instead of only reachable through an HTTP handler.
//
// Two phases, deliberately split around the mutation lock:
//   Phase 1 (no lock): snapshot the project, run all network fetches (native
//     registry latest-versions + OSV advisory tree). Holding `withData` through
//     60s+ of fetches would freeze every other writer.
//   Phase 2 (locked): re-load under `withData` and apply mutations — store vuln
//     results, then reconcile security/outdated/update tags.
//
// A process-wide SCAN_GATE bounds total concurrent scans so a startup sweep of
// many projects can't open a burst of HTTPS connections (rate-limit/ban risk).

import { loadData, withData, normalizeTagContent, assignNum } from "./data";
import { latestVersions, synthesizeStatus, type VersionInfo } from "./registry";
import { osvEcosystem, scanTree, type PkgVuln } from "./osv";
import { enumerateDepTree } from "./lockfile-tree";
import { loadVulnIgnore } from "./vuln-ignore";
import { broadcast } from "./broadcast";
import { softFail } from "./soft-fail";
import { currentLang } from "./i18n";
import { ecoMap } from "./eco-map";

const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);

const REGISTRY_CHECK_DISABLED = process.env.DEVLOG_REGISTRY_CHECK_DISABLED === "1";
const VULN_CHECK_DISABLED = process.env.DEVLOG_VULN_CHECK_DISABLED === "1";

// Global concurrency gate across ALL projects' scans. latestVersions already
// caps to 4 requests per scan, but the startup sweep fired runVulnScan for all
// scannable projects at once → up to ~112 concurrent HTTPS connections in a
// burst. This bounds total in-flight scans so the worst case is SCAN_GATE × 4
// connections (R4 devops F4).
const SCAN_GATE = 3;
let scansRunning = 0;
const scanQueue: Array<() => void> = [];
async function acquireScanSlot(): Promise<void> {
  if (scansRunning >= SCAN_GATE) await new Promise<void>(resolve => scanQueue.push(resolve));
  scansRunning++;
}
function releaseScanSlot(): void {
  scansRunning--;
  scanQueue.shift()?.();
}

export async function runVulnScan(name: string) {
  if (REGISTRY_CHECK_DISABLED) return;
  await acquireScanSlot();
  try {
    // Phase 1 (no lock): snapshot project profile, run network fetches.
    // Lock-holding through 60s+30s fetches would freeze every other writer.
    const snapshot = await loadData();
    const projectSnap = snapshot.projects[name];
    if (!projectSnap || projectSnap.libraries.length === 0) return;

    // Ecosystem is PER LIBRARY, not per project: the scanner stamps each library
    // with its source manifest's ecosystem (Tauri merges package.json + Cargo.toml
    // into one list, so a single project-wide ecosystem cross-matched Rust crates
    // against same-named npm packages — reqwest/tar/openssl false positives, and
    // zero RustSec coverage). Profiles stored before that fix have no stamp and
    // fall back to the project-language mapping; a library with neither is skipped
    // rather than guessed.
    const defaultEco = ecoMap[projectSnap.language] || "";
    const packages = projectSnap.libraries.map(l => ({
      name: l.name,
      version: l.version.replace(/[\^~>=<\s]/g, "") || "latest",
      eco: l.eco || defaultEco,
    }));
    if (packages.every(p => !p.eco)) {
      // No registry mapping anywhere (e.g. Zig, "Unknown") — skip the scan
      // instead of guessing. Cross-ecosystem matches produce false positives.
      return;
    }
    const groupByEco = <T extends { eco: string }>(items: T[]): Map<string, T[]> => {
      const g = new Map<string, T[]>();
      for (const it of items) {
        if (!it.eco) continue;
        const arr = g.get(it.eco);
        if (arr) arr.push(it); else g.set(it.eco, [it]);
      }
      return g;
    };

    // Native latest-version lookup — the source of truth for "outdated". One
    // registry query batch per ecosystem group, merged by name (a name colliding
    // across ecosystems in one project keeps the first group's answer).
    const nativeLatest = new Map<string, VersionInfo>();
    for (const [eco, group] of groupByEco(packages)) {
      const m = await latestVersions(eco, group.map(p => p.name));
      for (const [n, v] of m) if (!nativeLatest.has(n)) nativeLatest.set(n, v);
    }
    // Whole days since an ISO date — feeds the dashboard's "released N days ago"
    // caption and its <7-day "fresh, wait before upgrading" warning.
    const daysSince = (iso: string | null): number | null => {
      if (!iso) return null;
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return null;
      return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
    };

    // CVE axis (OSV.dev) — the native scan above sees only freshness; OSV adds the
    // known-advisory data that lets the reconciliation loop create/close security
    // tags. Independent opt-out (air-gapped users who still want outdated tracking).
    // Full dependency tree (direct + transitive) from the lockfile — most vulns
    // live in transitive deps that the direct-only `packages` list misses (~half,
    // verified vs bun/cargo audit). Falls back to the direct list when no lockfile.
    // Capped so a giant monorepo can't issue an unbounded scan. Freshness stays on
    // direct deps only (the dashboard's library view); the tree is vuln-coverage only.
    // Each ecosystem group is scanned against ITS OWN OSV ecosystem; a group with
    // no OSV mapping (vcpkg/C-C++) stays freshness-only, as before.
    const tree = VULN_CHECK_DISABLED ? [] : await enumerateDepTree(projectSnap.path);
    const treePackages = (tree.length ? tree : packages).slice(0, 2000)
      .map(p => ({ name: p.name, version: p.version.replace(/[\^~>=<\s]/g, "") || "latest", eco: p.eco }));
    const vulnByPkg = new Map<string, PkgVuln>();
    // Ecosystems whose OSV scan actually ran — gates security-tag creation and
    // auto-close below PER PACKAGE, so a freshness-only group (or a disabled
    // vuln check) never touches that group's security tags.
    const osvEcos = new Set<string>();
    if (!VULN_CHECK_DISABLED) {
      const ignore = await loadVulnIgnore(projectSnap.path);
      for (const [eco, group] of groupByEco(treePackages)) {
        const osvEco = osvEcosystem(eco);
        if (!osvEco) continue;
        osvEcos.add(eco);
        const res = await scanTree(osvEco, group.map(p => ({ name: p.name, version: p.version })), fetch, ignore);
        for (const [n, pv] of res) {
          const prev = vulnByPkg.get(n);
          // Same name in two ecosystems: keep whichever is vulnerable.
          if (!prev || (prev.vulns === 0 && pv.vulns > 0)) vulnByPkg.set(n, pv);
        }
      }
    }

    // Direct deps: native freshness + OSV vuln verdict (keyed by name → exact
    // installed version from the tree). OSV "ok:false" (query failed / non-numeric
    // version) → indeterminate, so a transient OSV outage never auto-closes a tag.
    const directNames = new Set(packages.map(p => p.name));
    const directResults = packages.map(p => {
      // synthesizeStatus distinguishes "indeterminate" (registry lookup failed →
      // latest UNKNOWN) from "safe" (R4 code-quality F1).
      const s = synthesizeStatus(p.version, nativeLatest.get(p.name));
      const fresh = { isLatest: s.isLatest, latestVersion: s.latestVersion, latestReleaseDate: s.date || "", daysSinceLatest: daysSince(s.date) };
      const pv = vulnByPkg.get(p.name);
      if (pv?.ok && pv.vulns > 0) {
        // vulnVersion: the resolved version the advisories actually hit. A lockfile
        // can hold the same name at two versions (reqwest 0.12 + 0.13); blaming the
        // direct version for a transitive-only hit sends the user at a clean target.
        return { name: p.name, version: p.version, eco: p.eco, vulnVersion: pv.version || p.version, status: pv.status, icon: pv.icon, message: pv.message, severity: pv.severity, topVuln: pv.topVuln, fixVersion: pv.fixVersion, vulns: pv.vulns, notices: pv.notices, detailsUrl: pv.detailsUrl, advisories: pv.advisories, direct: true, ...fresh };
      }
      if (pv && !pv.ok) {
        return { name: p.name, version: p.version, eco: p.eco, status: "indeterminate", direct: true, ...fresh };
      }
      // Notice-only (unmaintained/unsound, zero CVEs): keep status "safe" — no
      // tag, and any open security tag auto-closes — but carry the notice count
      // + labeled advisories so the dashboard can say "غير مُصان" honestly.
      const noticeExtra = pv?.ok && pv.notices > 0
        ? { notices: pv.notices, advisories: pv.advisories, message: pv.message, detailsUrl: pv.detailsUrl }
        : {};
      return { name: p.name, version: p.version, eco: p.eco, status: s.status, direct: true, ...noticeExtra, ...fresh };
    });
    // Transitive deps: vuln verdict only (no freshness). Vulnerable ones create
    // security tags + get stored; clean ones pass through ONLY so a previously
    // opened security tag can auto-close (the storage loop skips them to stay bounded).
    const transitiveResults: Record<string, unknown>[] = [];
    for (const [pkgName, pv] of vulnByPkg) {
      if (directNames.has(pkgName) || !pv.ok) continue;
      const node = treePackages.find(t => t.name === pkgName);
      // Prefer the verdict's own version — with the same name resolved at two
      // versions, `find` returns an arbitrary one; pv.version is the scanned one.
      const base = { name: pkgName, version: pv.version || node?.version || "", eco: node?.eco || "", direct: false, isLatest: undefined, latestVersion: "", latestReleaseDate: "", daysSinceLatest: null };
      if (pv.vulns > 0) {
        transitiveResults.push({ ...base, status: pv.status, icon: pv.icon, message: pv.message, severity: pv.severity, topVuln: pv.topVuln, fixVersion: pv.fixVersion, vulns: pv.vulns, detailsUrl: pv.detailsUrl, advisories: pv.advisories });
      } else {
        transitiveResults.push({ ...base, status: "safe" });
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: merged direct+transitive scan results flow loosely through the tag-reconciliation pipeline below; every field is sanitized at storage (sStr/sUrl) and re-validated at each render sink.
    const libResults: { results: any[] } = { results: [...directResults, ...transitiveResults] };

    // Phase 2 (with lock): apply mutations on a fresh snapshot.
    return await withData(async (data) => {
      const project = data.projects[name];
      if (!project) return; // project deleted between phases — drop results

    // Store vuln results
    if (libResults?.results) {
      const vulnMap: Record<string, unknown> = {};
      // Sanitize fields from the (external, possibly attacker-controlled) Vuln API
      // at the source — defense-in-depth beyond safeHref at the render sink (D4).
      const sStr = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : "";
      const sUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\//i.test(v)) ? v.slice(0, 500) : "";
      const priorVuln = project.vulnResults || {};
      for (const pkg of libResults.results) {
        // Indeterminate (registry lookup failed) — latest is unknown. Keep the
        // last known entry rather than overwriting it with a misleading
        // isLatest=true; if there's no prior entry, leave it out (R4 cq F1).
        if (pkg.status === "indeterminate") {
          const keep = priorVuln[pkg.name];
          if (keep) vulnMap[sStr(pkg.name, 100)] = keep;
          continue;
        }
        // Don't store CLEAN transitive deps — a project's tree is hundreds of nodes
        // and persisting every safe one would bloat the dataset. They still flow
        // through the tag-reconciliation loop below (to auto-close a fixed vuln);
        // here we keep only direct deps + any transitive dep that actually has a vuln.
        if (pkg.direct === false && !(pkg.vulns > 0)) continue;
        // Sanitize each advisory at the source too (external OSV data). Cap at 25
        // so a package with a huge advisory list can't bloat the stored dataset.
        const advisories = Array.isArray(pkg.advisories)
          ? pkg.advisories.slice(0, 25).map((a: Record<string, unknown>) => ({
              id: sStr(a?.id, 60), severity: sStr(a?.severity, 20) || "none",
              summary: sStr(a?.summary, 300), fix: sStr(a?.fix, 50), url: sUrl(a?.url),
              kind: sStr(a?.kind, 20) || "vuln",
            }))
          : [];
        vulnMap[sStr(pkg.name, 100)] = { status: sStr(pkg.status, 20), icon: sStr(pkg.icon, 20), message: sStr(pkg.message, 500), vulns: pkg.vulns ?? 0, notices: pkg.notices ?? 0, severity: sStr(pkg.severity, 20) || "none", topVuln: pkg.topVuln || null, fixVersion: sStr(pkg.fixVersion, 50), latestVersion: sStr(pkg.latestVersion, 50), isLatest: pkg.isLatest === undefined ? true : pkg.isLatest, unscannableReason: sStr(pkg.unscannableReason, 200), detailsUrl: sUrl(pkg.detailsUrl), daysSinceFix: pkg.daysSinceFix ?? null, daysSinceLatest: pkg.daysSinceLatest ?? null, fixReleaseDate: sStr(pkg.fixReleaseDate, 40), latestReleaseDate: sStr(pkg.latestReleaseDate, 40), advisories, transitive: pkg.direct === false };
      }
      project.vulnResults = vulnMap as typeof project.vulnResults;
      project.vulnScanDate = new Date().toISOString();
    }

    // Auto-create security tags + auto-close fixed + track outdated
    const now = new Date().toISOString();

    // Cleanup: remove outdated tags for "latest" versions (meaningless)
    data.tags = data.tags.filter(t => !(t.project === name && t.tag === "outdated" && t.content.toLowerCase().includes("@latest")));

    // Cleanup: drop orphaned outdated tags — packages that no longer exist
    // in the project's library list. Happens when a dep is removed, or when
    // an older scanner version picked up libs the current one ignores
    // (e.g. Rust crates before the nested-manifest merge). Safe because the
    // function already early-returned if libraries is empty.
    const currentLibNames = new Set(projectSnap.libraries.map(l => l.name.toLowerCase()));
    data.tags = data.tags.filter(t => {
      if (t.project !== name || t.tag !== "outdated") return true;
      const m = t.content.match(/^([^\s@]+)@/);
      if (!m) return true;
      return currentLibNames.has(m[1].toLowerCase());
    });

    const existingSecTags = data.tags.filter(t => t.project === name && t.tag === "security");
    const existingSecTexts = new Set(existingSecTags.map(t => normalizeTagContent(t.content)));
    const existingSecFixTexts = new Set(data.tags.filter(t => t.project === name && t.tag === "security fix").map(t => normalizeTagContent(t.content)));
    const existingOutdatedTexts = new Set(data.tags.filter(t => t.project === name && t.tag === "outdated").map(t => normalizeTagContent(t.content)));

    if (libResults?.results) {
      for (const pkg of libResults.results) {
        // Indeterminate: native registry lookup failed (transient/404), latest
        // is UNKNOWN. Leave EVERY tag for this package untouched — never evict an
        // `outdated` tag and never forge an `update` tag off a guess (R4 cq F1).
        if (pkg.status === "indeterminate") continue;
        // Status semantics (per Vuln API v1):
        //   "danger"   — malware OR vuln with no fix    → security tag
        //   "update"   — vuln, fix available            → security tag
        //   "outdated" — no CVE, just behind on version → outdated tag (informational)
        //   "safe"     — no CVE AND on latest           → close any open tags
        // "unscannable" (v0.5.1-beta) — input couldn't be resolved (vendored,
        // undefined, etc). "unknown" (v0.5.6-beta) — package not in any
        // registry. Both: don't treat as safe or dangerous, don't churn tags.
        // Also evict any stale `outdated` tag left over from older API versions
        // that cross-matched this package against an unrelated registry entry.
        if (pkg.status === "unscannable" || pkg.status === "unknown") {
          for (let i = data.tags.length - 1; i >= 0; i--) {
            const t = data.tags[i];
            if (t.project === name && t.tag === "outdated" &&
                t.content.toLowerCase().startsWith(`${pkg.name.toLowerCase()}@`)) {
              data.tags.splice(i, 1);
            }
          }
          continue;
        }

        const hasCve = pkg.status === "update" || pkg.status === "danger";
        const isOutdated = pkg.status === "outdated";
        const isSafe = pkg.status === "safe";

        // Security tags only when we actually have CVE data (external API) FOR
        // THIS PACKAGE'S ECOSYSTEM. A native version-only scan knows nothing
        // about vulnerabilities, so it must never create or auto-close security
        // tags — and an OSV run for npm says nothing about a vcpkg library.
        if (osvEcos.has(pkg.eco)) {
          if (hasCve) {
            const text = `${pkg.name}@${pkg.vulnVersion || pkg.version} — ${pkg.message}`.slice(0, 100);
            const norm = normalizeTagContent(text);
            if (!existingSecTexts.has(norm)) {
              data.tags.push({ id: crypto.randomUUID(), project: name, tag: "security", content: text, timestamp: now, num: assignNum(data, name) });
            }
            // Supersede: one open claim per package. An older OPEN security tag
            // for the SAME package with a DIFFERENT text (message drift, or a
            // stale pre-fix cross-ecosystem claim) is closed — the tag just
            // pushed carries the current truth, and two contradicting open
            // entries for one package is exactly what made the card read wrong.
            for (const secTag of existingSecTags) {
              const low = normalizeTagContent(secTag.content);
              if (low === norm || !low.startsWith(`${pkg.name.toLowerCase()}@`)) continue;
              if (existingSecFixTexts.has(low)) continue;
              data.tags.push({ id: crypto.randomUUID(), project: name, tag: "security fix", content: secTag.content, timestamp: now });
              existingSecFixTexts.add(low);
            }
          } else {
            // No CVE on this lib — auto-close any open security tags for it
            for (const secTag of existingSecTags) {
              const low = normalizeTagContent(secTag.content);
              if (low.startsWith(`${pkg.name.toLowerCase()}@`) && !existingSecFixTexts.has(low)) {
                data.tags.push({ id: crypto.randomUUID(), project: name, tag: "security fix", content: secTag.content, timestamp: now });
                existingSecFixTexts.add(low);
              }
            }
          }
        }

        // Track outdated: status === "outdated", or status === "safe" but version is behind.
        const behindVersion = pkg.isLatest === false && pkg.latestVersion && pkg.version !== "latest";
        if ((isOutdated || (isSafe && behindVersion)) && pkg.latestVersion) {
          const text = `${pkg.name}@${pkg.version} — ${L("latest", "احدث")}: ${pkg.latestVersion}`.slice(0, 100);
          if (!existingOutdatedTexts.has(normalizeTagContent(text))) {
            const idx = data.tags.findIndex(t => t.project === name && t.tag === "outdated" && t.content.toLowerCase().startsWith(`${pkg.name.toLowerCase()}@`));
            if (idx >= 0) data.tags.splice(idx, 1);
            data.tags.push({ id: crypto.randomUUID(), project: name, tag: "outdated", content: text, timestamp: now });
          }
        } else if (pkg.isLatest === true) {
          // Library is latest — remove outdated tag + create update tag if was outdated
          const outdatedIdx = data.tags.findIndex(t => t.project === name && t.tag === "outdated" && t.content.toLowerCase().startsWith(`${pkg.name.toLowerCase()}@`));
          if (outdatedIdx >= 0) {
            data.tags.splice(outdatedIdx, 1);
            // Create update tag as proof it was updated
            const updateText = `${pkg.name} — ${L("updated to", "تم التحديث الى")} ${pkg.version}`.slice(0, 100);
            const hasUpdate = data.tags.some(t => t.project === name && t.tag === "update" && normalizeTagContent(t.content) === normalizeTagContent(updateText));
            if (!hasUpdate) {
              data.tags.push({ id: crypto.randomUUID(), project: name, tag: "update", content: updateText, timestamp: now });
            }
          }
        }
      }
    }
      broadcast("vuln", { project: name });
      return { libraries: libResults };
    });
  } catch (e) { softFail("runVulnScan", e); }
  finally { releaseScanSlot(); }
}
