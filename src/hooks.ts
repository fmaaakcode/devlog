import type { EventEntry } from "./types";
import { projectName } from "./data";

const MAX_DIFF_FIELD_BYTES = 10000;

// Files whose old_string/new_string/content shouldn't be persisted at all —
// they routinely carry secrets that would leak via /api/changes/by-id/:id.
// Path-based only (no regex secret detection — false positives + hides the
// user's own data from themselves).
const SENSITIVE_PATH_RE = /(?:^|[/\\])(?:\.env(?:\.|$)|\.npmrc$|\.pgpass$|id_rsa(?:\.pub)?$|id_ed25519(?:\.pub)?$|.+\.(?:pem|key|p12|pfx|asc)$|.*credentials.*|.*\.secret(?:s)?$)/i;

function isSensitivePath(p: string | undefined): boolean {
  return typeof p === "string" && SENSITIVE_PATH_RE.test(p);
}

function capContent(s: unknown): string | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  if (s.length <= MAX_DIFF_FIELD_BYTES) return s;
  return `${s.slice(0, MAX_DIFF_FIELD_BYTES)}\n…[truncated, original ${s.length} chars]`;
}

export function parseHookEvent(body: any): EventEntry {
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

  // PostToolUse: Bash
  if (hookEvent === "PostToolUse" && toolName === "Bash") {
    base.tool = "Bash";
    base.type = "command";
    base.command = body.tool_input?.command || "";
    base.description = body.tool_input?.description || "";
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
