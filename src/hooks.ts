// Translation layer between Claude Code's hook payloads and DevLog's event
// store: one raw hook POST body in, one normalized EventEntry out. Every hook
// event DevLog understands (SessionStart, PostToolUse Write/Edit/Bash, Stop, …)
// is classified here into the small `type` vocabulary the dashboard, retention
// and recall all read — so the shape of Claude's payload is known in exactly
// one file.
//
// Pure and I/O-free on purpose: the routes own loading/saving, this owns
// interpretation, which makes every classification decision unit-testable.
// Two guards live here because they belong to interpretation, not storage:
// content fields are capped (MAX_DIFF_FIELD_BYTES) so a huge paste can't bloat
// the store, and sensitive paths (.env and friends) are redacted before the
// content ever reaches disk.

import type { EventEntry } from "./types";
import { projectName } from "./data";
import { isTestCommand } from "./verify-hint";
import { isSensitivePath } from "./sensitive-paths";

const MAX_DIFF_FIELD_BYTES = 10000;

function capContent(s: unknown): string | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  if (s.length <= MAX_DIFF_FIELD_BYTES) return s;
  return `${s.slice(0, MAX_DIFF_FIELD_BYTES)}\n…[truncated, original ${s.length} chars]`;
}

/**
 * Attribution cwd for a hook request: prefer the session's PROJECT DIR (the
 * X-DevLog-Project-Dir header, filled from CLAUDE_PROJECT_DIR by the sending
 * hook) over the payload's `cwd`. The payload cwd follows the session's shell —
 * a persistent `cd subdir/` in Bash drifts it away from the project root, and
 * under a no-git parent that drift minted phantom projects (the `reports`
 * incident). The project dir is pinned to where the session was opened, so it
 * can't drift. An absent/invalid header (old hooks, manual curl, tests) falls
 * back to the payload cwd unchanged.
 */
export function attributionCwd(
  projectDir: string,
  cwd: string,
  isReal: (p: string) => boolean,
): string {
  return projectDir && isReal(projectDir) ? projectDir : cwd;
}

// Shape of a Claude Code hook payload (the fields DevLog reads). Loose + all
// optional — hooks vary by event; unknown fields are ignored.
interface HookBody {
  hook_event_name?: string;
  tool_name?: string;
  cwd?: string;
  session_id?: string;
  source?: string;
  agent_id?: string;
  agent_type?: string;
  tool_input?: {
    file_path?: string; content?: string; old_string?: string; new_string?: string;
    command?: string; description?: string; prompt?: string; subagent_type?: string; subject?: string;
  };
  tool_response?: unknown;
}

// ── Command-outcome extraction (verify-hint v2 prerequisite) ─────────────────
// PostToolUse's tool_response used to be dropped at capture time, which left
// verify-hint unable to tell a passing test from a failing one. Derive a verdict
// HERE and store only that (never stdout — size + privacy). Three rungs:
//   1. a numeric exit-code field, under any of the names harnesses use
//   2. interrupted === true → failure
//   3. test commands only: the runner's own summary line in the output tail
//      (bun/jest/vitest "N fail", pytest/cargo "N failed", go/jest "FAIL")
// No rung matches → both fields stay undefined = unknown, and every consumer
// fails OPEN on unknown, so harnesses that send no tool_response keep today's
// behavior exactly.

const EXIT_CODE_FIELDS = ["exit_code", "exitCode", "code", "returnCode"] as const;
// [1-9]\d* on purpose: "0 fail"/"0 failed" is a PASS line, not a failure.
const FAIL_COUNT_RE = /(?:^|[^\w.])([1-9]\d*)\s+fail(?:ed|ures?|ing)?\b/i;
const FAIL_MARK_RE = /(?:^|\s)FAIL(?:ED)?(?::|\s|$)/;   // case-sensitive: go test / jest suite lines
const PASS_RE = /\b\d+\s+pass(?:ed|ing)?\b|\b0\s+fail(?:ed)?\b|\ball tests passed\b/i;

export function commandOutcome(resp: unknown, command: string): { exit_code?: number; ok?: boolean } {
  if (!resp || typeof resp !== "object") return {};
  const r = resp as Record<string, unknown>;
  for (const f of EXIT_CODE_FIELDS) {
    const v = r[f];
    if (typeof v === "number" && Number.isFinite(v)) return { exit_code: v, ok: v === 0 };
  }
  if (r.interrupted === true) return { ok: false };
  if (!isTestCommand(command)) return {};
  // Summaries print at the END of output — the tail is enough and caps the scan.
  const text = ["stdout", "stderr", "output"]
    .map(f => (typeof r[f] === "string" ? (r[f] as string).slice(-4000) : ""))
    .join("\n");
  if (!text.trim()) return {};
  if (FAIL_COUNT_RE.test(text) || FAIL_MARK_RE.test(text)) return { ok: false };
  if (PASS_RE.test(text)) return { ok: true };
  return {};
}

export function parseHookEvent(body: HookBody): EventEntry {
  const hookEvent = body.hook_event_name || "";
  const toolName = body.tool_name || "";
  const cwd = body.cwd || "";
  const name = projectName(cwd);
  const now = new Date().toISOString();

  const base: EventEntry = {
    id: crypto.randomUUID(),
    project: name,
    event: hookEvent,
    type: "change",
    session_id: body.session_id,
    timestamp: now,
  };
  // Persist the path on session starts only (one per session keeps events
  // lean) so the event log can rebuild name→path if the registry is lost.
  if (hookEvent === "SessionStart" && cwd) base.cwd = cwd;

  // PostToolUse: Write (create new file)
  if (hookEvent === "PostToolUse" && toolName === "Write") {
    base.tool = "Create";
    base.type = "create";
    base.file_path = body.tool_input?.file_path || "";
    base.content = isSensitivePath(base.file_path)
      ? "[redacted: sensitive path]"
      : capContent(body.tool_input?.content);
    return base;
  }

  // PostToolUse: Edit
  if (hookEvent === "PostToolUse" && toolName === "Edit") {
    base.tool = "Edit";
    base.file_path = body.tool_input?.file_path || "";
    if (isSensitivePath(base.file_path)) {
      base.old_string = "[redacted: sensitive path]";
      base.new_string = "[redacted: sensitive path]";
    } else {
      base.old_string = capContent(body.tool_input?.old_string);
      base.new_string = capContent(body.tool_input?.new_string);
    }
    return base;
  }

  // PostToolUse: Read
  if (hookEvent === "PostToolUse" && toolName === "Read") {
    base.tool = "Read";
    base.type = "read";
    base.file_path = body.tool_input?.file_path || "";
    return base;
  }

  // PostToolUse: Bash / PowerShell (both are shell-command tools; Windows sessions
  // run tests via PowerShell, so missing it breaks verify hints and recall)
  if (hookEvent === "PostToolUse" && (toolName === "Bash" || toolName === "PowerShell")) {
    base.tool = toolName;
    base.type = "command";
    base.command = body.tool_input?.command || "";
    base.description = body.tool_input?.description || "";
    const outcome = commandOutcome(body.tool_response, base.command);
    if (outcome.exit_code !== undefined) base.exit_code = outcome.exit_code;
    if (outcome.ok !== undefined) base.ok = outcome.ok;
    return base;
  }

  // PostToolUse: Agent
  if (hookEvent === "PostToolUse" && toolName === "Agent") {
    base.tool = "Agent";
    base.type = "agent";
    base.description = body.tool_input?.prompt || body.tool_input?.description || "";
    base.agent_type = body.tool_input?.subagent_type || "";
    return base;
  }

  // PostToolUse: EnterPlanMode
  if (hookEvent === "PostToolUse" && toolName === "EnterPlanMode") {
    base.tool = "Plan";
    base.type = "plan";
    base.description = "دخل وضع الخطة";
    return base;
  }

  // PostToolUse: ExitPlanMode
  if (hookEvent === "PostToolUse" && toolName === "ExitPlanMode") {
    base.tool = "Plan";
    base.type = "plan";
    base.description = "خرج من وضع الخطة";
    return base;
  }

  // SessionStart
  if (hookEvent === "SessionStart") {
    base.type = "session";
    base.event = "SessionStart";
    base.description = body.source || "startup";
    return base;
  }

  // Stop
  if (hookEvent === "Stop") {
    base.type = "session";
    base.event = "Stop";
    return base;
  }

  // SubagentStart
  if (hookEvent === "SubagentStart") {
    base.type = "agent";
    base.event = "SubagentStart";
    base.agent_type = body.agent_type || "";
    base.agent_id = body.agent_id || "";
    base.description = body.tool_input?.description || body.tool_input?.prompt || "";
    return base;
  }

  // SubagentStop
  if (hookEvent === "SubagentStop") {
    base.type = "agent";
    base.event = "SubagentStop";
    base.agent_id = body.agent_id || "";
    return base;
  }

  // TaskCreated
  if (hookEvent === "TaskCreated") {
    base.type = "task";
    base.event = "TaskCreated";
    base.description = body.tool_input?.subject || body.tool_input?.description || "";
    return base;
  }

  // TaskCompleted
  if (hookEvent === "TaskCompleted") {
    base.type = "task";
    base.event = "TaskCompleted";
    base.description = body.tool_input?.subject || "";
    return base;
  }

  // Fallback
  base.tool = toolName;
  base.event = hookEvent || "unknown";
  return base;
}
