// Where DevLog keeps its per-user state — ONE rule shared by the server (data
// dir) and the Stop hook (queue, turn ledger, debug log), so the two can never
// disagree about "the stable place on this machine".
//
// Why the hook needs it (#1040): parse-tags used to park everything under its
// own folder (`import.meta.dir/.devlog`). For a plugin user that folder is the
// plugin CACHE, versioned per release — `~/.claude/plugins/cache/devlog/devlog/
// 3.48.0/.devlog/tag-queue` and `…/3.49.0/…` were both live on the dev machine.
// A batch queued while the server was down sat in the OLD version's queue; the
// upgraded hook drained only its own (empty) queue, and Claude Code's cache
// cleanup eventually deleted the rest. No warning anywhere.
//
// Decision (2026-09-06, product): hook state lives INSIDE the data dir
// (`<data>/hook-state/`), not in a second per-user folder — one place to back
// up, one place `DEVLOG_DATA_DIR` moves. `DEVLOG_HOOK_STATE_DIR` overrides for
// the test harness, which must never touch a developer's live queue (#1201).
//
// The short-lived PreToolUse ack files (install/release/tracking/demolition
// acks, ≤ one session or 10 minutes) stay next to the hooks that write them:
// losing one on a plugin upgrade costs a single re-issued command, and moving
// them means touching three more hook scripts for no data-safety gain.

import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readdirSync } from "node:fs";

type Env = Record<string, string | undefined>;

/** The server's data dir: explicit override, else the per-user dir when running
 *  as a Claude Code plugin (its code dir is a cache replaced on every update),
 *  else `<rootDir>/.devlog-data` for a manual checkout. */
export function resolveDataDir(env: Env, rootDir: string, home: string = homedir()): string {
  return env.DEVLOG_DATA_DIR || (env.CLAUDE_PLUGIN_ROOT ? join(home, ".devlog", "data") : join(rootDir, ".devlog-data"));
}

/** Where the Stop hook keeps queue / turn ledger / debug log. */
export function resolveHookStateDir(env: Env, hookDir: string, home: string = homedir()): string {
  return env.DEVLOG_HOOK_STATE_DIR || join(resolveDataDir(env, hookDir, home), "hook-state");
}

/** Only a hook whose state dir was DERIVED (not overridden) may pull the
 *  machine's legacy queues in. An explicit DEVLOG_HOOK_STATE_DIR is an isolated
 *  sandbox — the test harness — and a sandboxed hook that migrates the
 *  developer's real quarantine files into a temp dir the suite later deletes is
 *  exactly what happened to 10 live `.json.rejected` files on 2026-09-06
 *  (recovered from the temp dir by hand; the rule exists so it cannot recur). */
export function shouldMigrateLegacyQueues(env: Env): boolean {
  return !env.DEVLOG_HOOK_STATE_DIR;
}

/** The pre-#1040 queue folders a fresh hook must drain into its new home: its
 *  own `<hookDir>/.devlog/tag-queue`, plus — when hookDir is a versioned plugin
 *  cache entry (`…/<x.y.z>`) — every sibling version's queue. Existence is not
 *  checked here; the migration tolerates missing dirs. */
export function legacyQueueDirs(hookDir: string): string[] {
  const dirs = [join(hookDir, ".devlog", "tag-queue")];
  if (/^\d+\.\d+\.\d+/.test(basename(hookDir))) {
    const parent = dirname(hookDir);
    let siblings: string[] = [];
    try { siblings = readdirSync(parent); } catch { /* unreadable parent → own dir only */ }
    // Directory enumeration order is a filesystem accident (NTFS sorts, ext4 and
    // APFS do not), and the order here decides which sibling's batch wins when
    // two legacy queues hold the same file name (migration never overwrites).
    // Sort by version so the outcome is the same on every OS: oldest first.
    siblings.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    for (const s of siblings) {
      if (s === basename(hookDir) || !/^\d+\.\d+\.\d+/.test(s)) continue;
      dirs.push(join(parent, s, ".devlog", "tag-queue"));
    }
  }
  return dirs;
}
