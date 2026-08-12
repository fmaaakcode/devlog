// The Stop hook's block channel — how it speaks to Claude, and which blocks
// count as enforcement (plan guard-telemetry, P2).
//
// HOW: JSON on stdout + exit(0) (`{decision:"block", reason}`), NOT stderr +
// exit(2). Exit 2 renders as a red hook *error* to the user, though every
// message here is normal protocol feedback (a release banner, an open-items
// list, a closure nudge). JSON-on-exit-0 gives identical "block the stop, feed
// the text back, continue the turn" semantics with no error label.
//
// Messages accrue in `feedback` so informational notes written earlier in a run
// (rollback / closure-confirm / verify-hint) ride out with the blocking message.
// On the no-block path the hook surfaces them at its natural exit(0) instead.
//
// WHICH COUNT: the hook blocks for two unrelated reasons and the wire looks
// identical for both.
//   · ENFORCEMENT — a guard refusing to let the turn end (a release with open
//     items, a closure that closed nothing, a fix with no cause).
//   · DELIVERY — the channel used to hand back something ASKED for (the
//     computed release, a standards pull, an -(ask:*) answer). Nothing was
//     refused; the continuation is how the answer arrives.
// Counting delivery as enforcement would inflate every ratio built on these
// numbers — an ask:map serve is not a guard catching a mistake. So each site
// names itself with a BlockKey and the table below decides. `null` is a
// DECISION, never an omission: the comment on each says why.
//
// The type is the enforcement: blockContinue takes a BlockKey, so a new block
// site cannot compile without picking one, and picking one means reading the
// table. Pinned by test/guard-telemetry.test.ts.

export const BLOCK_RULES = {
  // Enforcement — the telemetry `rule` is the same name the hook logs, so a log
  // line and a counter can never disagree about which guard spoke.
  "release-guard": "release-guard",           // local pre-check: open items block a release
  "feature-nudge": "feature-nudge",           // a release with work tags but zero features
  "release-downgrade": "release-downgrade",   // the computed version would go backwards
  "release-intent": "release-intent",         // a type tag carrying an explicit version
  "release-blocked": "release-blocked",       // the server's own open-items refusal
  upcoming: "upcoming",                       // a deferral that matched nothing, or security
  "closure-divergence": "closure-divergence", // #N applied, but its text is about something else
  "closure-mismatch": "closure-mismatch",     // #N closed nothing at all
  "feature-hints": "feature-hints",           // a feature update/removal that matched nothing
  "closure-check": "closure-check",           // work that finishes an open item with no closure

  // Delivery — not recorded.
  // `serve`: the release result, a standards pull, an -(ask:*) answer.
  serve: null,
  // `guard-own`: the six turn guards in hook-guards.ts record themselves by name
  // (P1) before they block. Recording again here would double every count.
  "guard-own": null,
} as const;

export type BlockKey = keyof typeof BLOCK_RULES;

/** The six turn guards (src/hook-guards.ts), which record themselves rather than
 *  going through the table above. Listed here so that "every countable rule on
 *  the `turn` gate" has ONE home: a reader with only the observed records cannot
 *  tell a guard that never spoke from a guard that does not exist, and the
 *  silence is the most valuable half of the signal. Pinned against the source in
 *  test/guard-telemetry.test.ts. */
export const GUARD_RULES = [
  "near-miss", "backtick-nudge", "standards-check", "dep-freshness", "untagged-guard", "root-cause",
] as const;

/** Every rule name the `turn` gate can carry: the guards plus the counted block
 *  sites. Delivery keys are excluded — they are never recorded, so listing them
 *  would report a permanent, meaningless silence. */
export const TURN_RULES: readonly string[] = [
  ...GUARD_RULES,
  ...(Object.keys(BLOCK_RULES) as BlockKey[])
    .map(k => ruleForBlock(k))
    .filter((r): r is string => r !== null),
];

/** The telemetry rule name for a block key, or null when the block is delivery
 *  and must not be counted. */
export function ruleForBlock(key: BlockKey): string | null {
  return BLOCK_RULES[key];
}

/** Record one enforcement block on the `turn` gate; a no-op for delivery keys.
 *  Awaited BEFORE the block is written, because writing it exits the process and
 *  a post that dies with it would leave a live guard looking exactly like a dead
 *  one. Failure is swallowed: the block happens whether the counter does. */
export async function recordBlock(server: string, cwd: string, key: BlockKey): Promise<void> {
  const rule = ruleForBlock(key);
  if (!rule) return;
  try {
    const { postRuleTelemetry } = await import("./telemetry-client");
    await postRuleTelemetry(server, cwd, [{ gate: "turn", action: "fire", rule }], 800);
  } catch { /* a counter is never worth losing the block */ }
}

/**
 * The channel itself. `finalize` is the hook's finalizeTurn (#752: every exit
 * path must run Parts 2+3 — a blocking stop used to exit before them), passed as
 * a thunk because it is declared further down the hook file. `cwdOf` is a thunk
 * for the same reason: cwd is parsed from stdin after this is built.
 */
export function makeBlockChannel(server: string, cwdOf: () => string, finalize: () => Promise<void>) {
  const feedback: string[] = [];
  async function flushBlock(key: BlockKey): Promise<never> {
    await recordBlock(server, cwdOf(), key);
    await finalize();
    process.stdout.write(JSON.stringify({ decision: "block", reason: feedback.join("\n") }));
    process.exit(0);
  }
  async function blockContinue(text: string, key: BlockKey): Promise<never> {
    feedback.push(text);
    return flushBlock(key);
  }
  return { feedback, flushBlock, blockContinue };
}
