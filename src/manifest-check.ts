// Manifest toolchain check (P2) — verifies a language manifest pins the NEWEST
// toolchain EDITION. This is the LANGUAGE half of the freshness model: a
// language edition takes the absolute latest with NO cooldown (newest = best),
// unlike third-party libraries which get the 7-day maturity window (dep-check.ts).
//
// `rust-version` is deliberately NOT judged (#1112): it declares the MINIMUM
// rustc the crate supports (MSRV), not the toolchain the project builds with —
// that lives in rust-toolchain.toml. Pushing it to the newest stable turns the
// crate hostile to every older compiler, including the project's own pinned one.
//
// Pure decision logic (no FS/network) so it's unit-testable; the write-time gate
// (pre-standards.js) supplies the written manifest text + the live target
// (latestToolchain for version, latestKnownEdition for the network-free edition).
//
// Why a manifest needs its own check: `Cargo.toml` is classified "non-code" by the
// standards gate (isCodeWrite), so it slips through — yet the edition/version the
// rule governs lives EXACTLY there. This closes that gap with a targeted check,
// not a blanket gate.

import { normalizeSlashes } from "./path-utils";

/** Which manifest a path is, or null if it isn't one we check. Extensible:
 *  more build files slot in here by basename. */
export function manifestKind(filePath: string): "cargo" | "cmake" | "makefile" | null {
  const base = normalizeSlashes(filePath).split("/").pop()?.toLowerCase();
  if (base === "cargo.toml") return "cargo";
  if (base === "cmakelists.txt") return "cmake";
  if (base === "makefile") return "makefile";
  return null;
}

export interface ManifestState {
  edition: string | null; // edition pinned in the manifest (e.g. "2021"), null if absent
  version: string | null; // `rust-version` = MSRV (minimum supported rustc), null if absent — informational, never enforced
}

/** Extract the edition + rust-version a Cargo.toml pins. Mirrors scanner.ts's
 *  detectRuntime regexes so detection and enforcement read the manifest the same
 *  way. Absent fields → null (we only check what is actually written). */
export function parseCargoManifest(text: string): ManifestState {
  const t = text || "";
  const ed = t.match(/edition\s*=\s*"(\d+)"/);
  const rv = t.match(/rust-version\s*=\s*"([^"]+)"/);
  return { edition: ed ? ed[1] : null, version: rv ? rv[1] : null };
}

/** The C++ standard a build file pins, mirroring scanner.ts's detectRuntime:
 *  CMake `CMAKE_CXX_STANDARD 20` → "C++20", Makefile `-std=c++20`/`gnu++20` → as-is.
 *  C++ has no single toolchain-version pin like rust-version, so `version` stays null. */
export function parseCppManifest(text: string): ManifestState {
  const t = text || "";
  const cmake = t.match(/CMAKE_CXX_STANDARD\s+(\d+)/);
  if (cmake) return { edition: `C++${cmake[1]}`, version: null };
  const std = t.match(/-std=(c\+\+\d+|gnu\+\+\d+)/i);
  if (std) return { edition: std[1], version: null };
  return { edition: null, version: null };
}

/** Year embedded in an edition label: rust "2021" → 2021, C++ "C++20" → 20.
 *  Editions are never compared across languages, so the differing scale is fine. */
function editionYear(ed: string): number | null {
  const m = (ed || "").match(/(\d{2,4})/);
  return m ? parseInt(m[1], 10) : null;
}

/** Is `found` an OLDER edition than `target`? Unknown either side → false (never
 *  block on something we can't compare). */
export function editionBehind(found: string, target: string): boolean {
  const f = editionYear(found);
  const t = editionYear(target);
  if (f == null || t == null) return false;
  return f < t;
}

export interface ToolchainTarget {
  latestEdition: string | null; // from latestKnownEdition (network-free); null = no edition concept
}

export interface ToolchainViolation {
  field: "edition";
  found: string;
  target: string;
}

/**
 * Violations of the language-freshness rule for a manifest: the pinned edition
 * is older than the latest (network-free target). The MSRV field is never a
 * violation (see the header) — the gate needs no network and never fails open.
 */
export function checkToolchain(state: ManifestState, target: ToolchainTarget): ToolchainViolation[] {
  const out: ToolchainViolation[] = [];
  if (state.edition && target.latestEdition && editionBehind(state.edition, target.latestEdition)) {
    out.push({ field: "edition", found: state.edition, target: target.latestEdition });
  }
  return out;
}
