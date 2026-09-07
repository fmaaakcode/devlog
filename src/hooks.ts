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
// content ever reaches disk. The command channel gets the value-level
// counterpart (secret-redact.ts): a token typed inline in a shell command is
// blanked, the rest of the command is kept.

import type { EventEntry } from "./types";
import { projectName } from "./data";
import { isTestCommand } from "./verify-hint";
import { isSensitivePath } from "./sensitive-paths";
import { redactSecrets } from "./secret-redact";
import { clipUnits } from "./text-clip";

const MAX_DIFF_FIELD_BYTES = 10000;

function capContent(s: unknown): string | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  if (s.length <= MAX_DIFF_FIELD_BYTES) return s;
  // clipUnits, not slice (F-3.7): a cut inside an astral pair left a lone
  // surrogate that every viewer rendered as U+FFFD.
  return `${clipUnits(s, MAX_DIFF_FIELD_BYTES)}\n…[truncated, original ${s.length} chars]`;
}

// F-3.4: only content/old/new were capped; `command`, `description` and the
// agent prompt were stored whole — a 200,000-char subagent prompt landed in
// events.json as one description (verified live), and pushEvent's retention
// bounds the COUNT of events, never their size. Same cap as the diff fields;
// the marker keeps the truncation visible to every reader.
const capField = (s: unknown): string => capContent(s) ?? "";

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
// Case-sensitive AND line-anchored (F-3.2): go's `--- FAIL: TestX` / `FAIL\tpkg`,
// jest's `FAIL src/x.test.ts` and pytest's `FAILED tests/x.py::t` all start
// the line. The old `(?:^|\s)FAIL` matched the word anywhere, so a PASSING
// test whose NAME contains it (`✓ returns FAIL when input empty`) read as a
// red suite — and the marker check runs before the pass summary can rescue it.
const FAIL_MARK_RE = /^(?:--- )?FAIL(?:ED)?(?::|\s|$)/m;
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

// Classification tables — one entry per event kind instead of twelve chained
// ifs. Each builder returns the fields to lay over `base` (so anything not
// named keeps base's value — Edit stays type "change" on purpose). Two tables
// because the payload is keyed twice: PostToolUse events classify by TOOL name,
// everything else by the hook event name itself.
type EventPatch = (body: HookBody) => Partial<EventEntry>;

// Bash / PowerShell share one builder (both are shell-command tools; Windows
// sessions run tests via PowerShell, so missing it breaks verify hints and recall).
const shellCommand: EventPatch = body => {
  const command = body.tool_input?.command || "";
  const outcome = commandOutcome(body.tool_response, command);
  // The verdict is derived from the RAW command (it classifies the shape);
  // only the stored text has its secret values blanked (F-3.5).
  return {
    tool: body.tool_name || "", type: "command", command: capField(redactSecrets(command)),
    description: capField(body.tool_input?.description),
    ...(outcome.exit_code !== undefined && { exit_code: outcome.exit_code }),
    ...(outcome.ok !== undefined && { ok: outcome.ok }),
  };
};

const TOOL_EVENTS: Record<string, EventPatch> = {
  Write: body => {
    const file_path = body.tool_input?.file_path || "";
    return {
      tool: "Create", type: "create", file_path,
      content: isSensitivePath(file_path)
        ? "[redacted: sensitive path]"
        : capContent(body.tool_input?.content),
    };
  },
  Edit: body => {
    const file_path = body.tool_input?.file_path || "";
    const redacted = isSensitivePath(file_path);
    return {
      tool: "Edit", file_path,
      old_string: redacted ? "[redacted: sensitive path]" : capContent(body.tool_input?.old_string),
      new_string: redacted ? "[redacted: sensitive path]" : capContent(body.tool_input?.new_string),
    };
  },
  Read: body => ({ tool: "Read", type: "read", file_path: body.tool_input?.file_path || "" }),
  Bash: shellCommand,
  PowerShell: shellCommand,
  Agent: body => ({
    tool: "Agent", type: "agent",
    description: capField(body.tool_input?.prompt || body.tool_input?.description),
    agent_type: body.tool_input?.subagent_type || "",
  }),
  // Plan-mode descriptions are English on purpose (audit C4): the description
  // is STORED on the event, so a hardcoded Arabic string leaked past the i18n
  // policy into every log — and no later language switch could fix it.
  EnterPlanMode: () => ({ tool: "Plan", type: "plan", description: "Entered plan mode" }),
  ExitPlanMode: () => ({ tool: "Plan", type: "plan", description: "Exited plan mode" }),
};

const LIFECYCLE_EVENTS: Record<string, EventPatch> = {
  SessionStart: body => ({ type: "session", event: "SessionStart", description: body.source || "startup" }),
  Stop: () => ({ type: "session", event: "Stop" }),
  SubagentStart: body => ({
    type: "agent", event: "SubagentStart",
    agent_type: body.agent_type || "",
    agent_id: body.agent_id || "",
    description: capField(body.tool_input?.description || body.tool_input?.prompt),
  }),
  SubagentStop: body => ({ type: "agent", event: "SubagentStop", agent_id: body.agent_id || "" }),
  TaskCreated: body => ({ type: "task", event: "TaskCreated", description: capField(body.tool_input?.subject || body.tool_input?.description) }),
  TaskCompleted: body => ({ type: "task", event: "TaskCompleted", description: capField(body.tool_input?.subject) }),
};

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

  // Object.hasOwn so a hostile key riding the payload ("toString",
  // "constructor") can't resolve to an inherited function and corrupt the event.
  const [table, key] = hookEvent === "PostToolUse"
    ? [TOOL_EVENTS, toolName] : [LIFECYCLE_EVENTS, hookEvent];
  if (Object.hasOwn(table, key)) return Object.assign(base, table[key](body));

  // Fallback. Must NOT inherit the initial "change": an unmatched lifecycle
  // event (UserPromptSubmit, Notification, …) stamped as "change" lives on the
  // 30-day code-diff retention schedule, competes for the per-project event
  // cap, and matches /api/classify's `type === "change"` overwrite filter.
  base.type = "session";
  base.tool = toolName;
  base.event = hookEvent || "unknown";
  return base;
}
