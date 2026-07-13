// Transcript-shape canary (#582).
//
// `readTurnFromTranscript` in parse-tags.ts reads Claude Code's session JSONL and
// reconstructs the assistant turn from it. That reconstruction rests on FOUR
// undocumented shape assumptions, none of which we control:
//
//   1. the file is JSONL — one JSON object per line;
//   2. a message's role is at `message.role` (or `role`), with the literal
//      vocabulary "user" / "assistant";
//   3. an assistant message's text lives in content blocks `{type:"text", text}`
//      (or a bare string), and tool results ride `{type:"tool_result"}` blocks on
//      role="user" entries — that block type is how we tell "tool output mid-turn"
//      from "a genuine new user turn";
//   4. harness-injected user entries (our own Stop-hook feedback, echoed back into
//      the transcript) carry `isMeta: true` — the flag that keeps a continuation
//      from being counted as a new turn boundary.
//
// If Claude Code renames a field or reshapes a block, every one of these degrades
// SILENTLY: tags stop being captured, or turn boundaries reset mid-turn, and the
// only symptom is a session whose work never reaches the log. This module reads a
// real transcript and asserts the four assumptions still hold, so the failure is
// announced the moment it appears instead of being discovered in a post-mortem.
//
// It is a DETECTOR, not a parser: it never extracts tag content, never stores a
// line, and reports only codes + counts.

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { currentLang } from "./i18n";

export type CanarySeverity = "break" | "degrade";

/** One violated assumption. `en`/`ar` are the user-facing detail lines. */
export interface CanaryFinding {
  code: string;
  severity: CanarySeverity;
  en: string;
  ar: string;
}

export interface CanaryReport {
  lines: number;
  parsed: number;
  assistant: number;
  /** assistant entries the parser can extract text from (the tag carriers) */
  assistantWithText: number;
  user: number;
  /** role="user" entries with STRING content — genuine prompts + meta feedback */
  userStrings: number;
  /** role="user" entries whose content is an array of tool_result blocks */
  userToolResult: number;
  /** Enough material to judge? A near-empty transcript proves nothing. */
  sufficient: boolean;
  findings: CanaryFinding[];
}

// Our own Stop-hook feedback as it looks once Claude Code echoes it back into the
// transcript. Its entry is the canonical isMeta carrier — if DevLog's own text
// shows up on a user entry WITHOUT the flag, assumption (4) is dead.
const FEEDBACK_MARKERS = ["[devlog ", "════════ DevLog"];

// A transcript proves nothing until the model has actually spoken in it: a fresh
// session's file holds one user line and no assistant turn at all.
const MIN_ASSISTANT = 1;
const MIN_USER = 1;

/**
 * Inspect raw transcript JSONL against the parse-tags assumptions. Pure — the
 * caller owns all I/O. Lines the parser itself ignores (attachments, mode
 * markers, file-history snapshots: entries with no resolvable role) are NOT
 * drift; they are a normal part of every transcript and are simply skipped, the
 * same way `readTurnFromTranscript` skips them.
 */
export function inspectTranscript(raw: string): CanaryReport {
  const lines = raw.split("\n").filter(Boolean);
  const findings: CanaryFinding[] = [];

  let parsed = 0;
  let assistant = 0;
  let assistantWithText = 0;
  let user = 0;
  let userStrings = 0;
  let userToolResult = 0;
  let userArrayBlocks = 0;
  let userArrayBlocksTyped = 0;
  let metaFeedbackUnflagged = 0;
  let boundariesWithoutKey = 0;

  for (const line of lines) {
    let obj: Record<string, unknown> & { message?: { role?: unknown; content?: unknown } };
    try { obj = JSON.parse(line); } catch { continue; }
    parsed++;

    const role = obj.message?.role ?? (obj as { role?: unknown }).role;
    const content = obj.message?.content ?? (obj as { content?: unknown }).content;

    if (role === "assistant") {
      assistant++;
      if (typeof content === "string") {
        if (content.trim()) assistantWithText++;
      } else if (Array.isArray(content)) {
        // Exactly the extraction parse-tags performs. A `thinking`/`tool_use`-only
        // message legitimately yields nothing — that's why the verdict below is an
        // aggregate ("NO assistant message yields text"), never a per-entry one.
        const hasText = content.some(b =>
          (b as { type?: unknown })?.type === "text" && typeof (b as { text?: unknown })?.text === "string");
        if (hasText) assistantWithText++;
      }
      continue;
    }

    if (role !== "user") continue;   // attachment / mode / system / snapshot lines
    user++;

    if (typeof content === "string") {
      userStrings++;
      const isFeedback = FEEDBACK_MARKERS.some(m => content.includes(m));
      const isMeta = (obj as { isMeta?: unknown }).isMeta === true;
      if (isFeedback && !isMeta) metaFeedbackUnflagged++;
      // A genuine (non-meta) user entry is a turn boundary: it must carry a key.
      if (!isMeta && !(obj as { uuid?: unknown }).uuid && !(obj as { timestamp?: unknown }).timestamp) {
        boundariesWithoutKey++;
      }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        userArrayBlocks++;
        if (typeof (b as { type?: unknown })?.type === "string") userArrayBlocksTyped++;
      }
      if (content.length > 0 && content.every(b => (b as { type?: unknown })?.type === "tool_result")) {
        userToolResult++;
      }
    }
  }

  const sufficient = assistant >= MIN_ASSISTANT && user >= MIN_USER;

  // (1) Still JSONL?
  if (lines.length > 0 && parsed === 0) {
    findings.push({
      code: "not-jsonl",
      severity: "break",
      en: "the transcript is no longer line-delimited JSON — not a single line parses.",
      ar: "الترانسكربت لم يعد JSON سطريًا — لا سطر واحد يُحلَّل.",
    });
    // Nothing below can be judged on unparsable input.
    return { lines: lines.length, parsed, assistant, assistantWithText, user, userStrings, userToolResult, sufficient: false, findings };
  }

  // (2) Role vocabulary reachable at message.role / role?
  if (parsed > 0 && assistant === 0 && user === 0) {
    findings.push({
      code: "no-roles",
      severity: "break",
      en: "no entry exposes a \"user\"/\"assistant\" role at `message.role` — the role field moved or was renamed.",
      ar: "لا مدخلة تكشف دور \"user\"/\"assistant\" في `message.role` — حقل الدور انتقل أو تغيّر اسمه.",
    });
    return { lines: lines.length, parsed, assistant, assistantWithText, user, userStrings, userToolResult, sufficient: false, findings };
  }

  if (!sufficient) {
    // Too thin to judge (a brand-new session). No findings — the caller falls back
    // to an older transcript rather than reporting a false all-clear.
    return { lines: lines.length, parsed, assistant, assistantWithText, user, userStrings, userToolResult, sufficient, findings };
  }

  // (3a) Assistant text — the tag carrier itself.
  if (assistantWithText === 0) {
    findings.push({
      code: "assistant-text-shape",
      severity: "break",
      en: `no text could be extracted from any of ${assistant} assistant message(s) — \`{type:"text", text}\` blocks are gone. Tag capture is DEAD.`,
      ar: `تعذّر استخراج أي نص من ${assistant} رسالة مساعد — كتل \`{type:"text", text}\` اختفت. التقاط التاقات معطَّل.`,
    });
  }

  // (3b) Typed blocks — how tool results are told apart from a real turn boundary.
  if (userArrayBlocks > 0 && userArrayBlocksTyped === 0) {
    findings.push({
      code: "block-type-missing",
      severity: "break",
      en: "user content blocks carry no `type` field — tool results can no longer be told apart from a genuine new turn, so turn boundaries reset mid-turn.",
      ar: "كتل محتوى المستخدم بلا حقل `type` — لم يعد يمكن تمييز نتائج الأدوات عن دور مستخدم جديد، فتنكسر حدود الدور داخل الدور نفسه.",
    });
  }

  // (4) isMeta on harness-injected feedback.
  if (metaFeedbackUnflagged > 0) {
    findings.push({
      code: "meta-flag-missing",
      severity: "break",
      en: `${metaFeedbackUnflagged} DevLog feedback entr(ies) came back as a user message WITHOUT \`isMeta: true\` — every hook continuation now counts as a new turn, wiping the per-turn ledger.`,
      ar: `${metaFeedbackUnflagged} تغذية راجعة من DevLog عادت كرسالة مستخدم بلا \`isMeta: true\` — كل متابعة hook تُحسب دورًا جديدًا، ما يمحو دفتر الدور.`,
    });
  }

  // (5) Turn key — degradation, not breakage: the parser falls back to a content
  // hash, which still works but loses stability across identical prompts.
  if (boundariesWithoutKey > 0) {
    findings.push({
      code: "turn-key-missing",
      severity: "degrade",
      en: `${boundariesWithoutKey} user turn(s) carry neither \`uuid\` nor \`timestamp\` — the turn id falls back to a content hash.`,
      ar: `${boundariesWithoutKey} دور مستخدم بلا \`uuid\` ولا \`timestamp\` — معرّف الدور يتراجع إلى بصمة المحتوى.`,
    });
  }

  return { lines: lines.length, parsed, assistant, assistantWithText, user, userStrings, userToolResult, sufficient, findings };
}

/** Render the findings as the user-facing systemMessage, in the active language. */
export function formatCanaryWarning(report: CanaryReport): string | null {
  if (!report.findings.length) return null;
  const ar = currentLang() === "ar";
  const broken = report.findings.some(f => f.severity === "break");
  const head = ar
    ? (broken
      ? "[DevLog] ⚠ بنية ترانسكربت Claude Code انحرفت عن افتراضات parse-tags — التقاط التاقات مهدَّد:"
      : "[DevLog] ⚠ انحراف طفيف في بنية ترانسكربت Claude Code:")
    : (broken
      ? "[DevLog] ⚠ Claude Code's transcript shape drifted from parse-tags' assumptions — tag capture is at risk:"
      : "[DevLog] ⚠ minor drift in Claude Code's transcript shape:");
  const body = report.findings.map(f => `  · ${ar ? f.ar : f.en}`);
  const foot = ar
    ? "راجع readTurnFromTranscript في parse-tags.ts قبل الاعتماد على أي وسم من هذه الجلسة."
    : "Check readTurnFromTranscript in parse-tags.ts before trusting any tag from this session.";
  return [head, ...body, foot].join("\n");
}

// Only the tail is inspected: a long session's JSONL reaches megabytes, and the
// shape question is answered by the most recent entries — the ones written by the
// Claude Code version running RIGHT NOW.
const MAX_BYTES = 512 * 1024;

async function readTail(path: string): Promise<string> {
  const f = Bun.file(path);
  const size = f.size;
  if (size <= MAX_BYTES) return await f.text();
  const raw = await f.slice(size - MAX_BYTES).text();
  const nl = raw.indexOf("\n");   // drop the partial first line
  return nl >= 0 ? raw.slice(nl + 1) : raw;
}

/**
 * Pick a transcript with enough material and inspect it.
 *
 * The session's OWN transcript is preferred — it is written by the running Claude
 * Code version, so drift shows up with zero lag. But at SessionStart that file is
 * usually empty (the session hasn't spoken yet), which proves nothing; then we
 * fall back to the newest sibling transcript in the same project folder. The
 * UserPromptSubmit call later in the session catches the current file once it has
 * a turn in it.
 */
export async function pickAndInspect(transcriptPath: string): Promise<{ path: string; report: CanaryReport; own: boolean } | null> {
  if (!transcriptPath) return null;
  const tried = new Set<string>();

  const consider = async (p: string, own: boolean): Promise<{ path: string; report: CanaryReport; own: boolean } | null> => {
    if (tried.has(p)) return null;
    tried.add(p);
    try {
      const report = inspectTranscript(await readTail(p));
      return report.sufficient || report.findings.length ? { path: p, report, own } : null;
    } catch { return null; }   // unreadable/vanished — try the next candidate
  };

  const own = await consider(transcriptPath, true);
  if (own) return own;

  // Newest siblings first — the previous sessions of this same project.
  let candidates: { p: string; mtime: number }[] = [];
  try {
    const dir = dirname(transcriptPath);
    const names = (await readdir(dir)).filter(n => n.endsWith(".jsonl"));
    candidates = (await Promise.all(names.map(async n => {
      const p = join(dir, n);
      try { return { p, mtime: (await stat(p)).mtimeMs }; } catch { return { p, mtime: 0 }; }
    }))).sort((a, b) => b.mtime - a.mtime);
  } catch { return null; }

  for (const c of candidates.slice(0, 3)) {
    const hit = await consider(c.p, false);
    if (hit) return hit;
  }
  return null;
}

// One alert per session: the drift is a property of the Claude Code build, not of
// the turn, so repeating it on every prompt would be pure noise. A server restart
// re-arms it — harmless, and it keeps the check honest after an upgrade.
const served = new Set<string>();

/** Reset the once-per-session gate (tests). */
export function resetCanaryGate(): void { served.clear(); }

/**
 * The SessionStart / UserPromptSubmit canary: inspect the transcript and return
 * the systemMessage to attach, or null when the shape still holds (or when there
 * isn't enough material yet — then the gate stays UNSPENT so a later prompt in
 * the same session, once the model has spoken, gets the real check).
 * Muted with DEVLOG_TRANSCRIPT_CANARY=0.
 */
export async function canaryWarningOnce(transcriptPath: string, sessionId: string): Promise<string | null> {
  if (process.env.DEVLOG_TRANSCRIPT_CANARY === "0") return null;
  const key = sessionId || transcriptPath;
  if (!key || served.has(key)) return null;

  // The canary's own lifeline: `transcript_path` is a Claude Code payload field we
  // don't control either. If a future build stops sending it on inject, this check
  // would go quietly inert — the exact silent-failure class it exists to catch.
  if (process.env.DEVLOG_DEBUG === "1") {
    console.warn(`[transcript-canary] session=${sessionId || "-"} transcript_path=${transcriptPath ? transcriptPath : "MISSING FROM PAYLOAD"}`);
  }

  const hit = await pickAndInspect(transcriptPath);
  if (!hit) return null;          // nothing conclusive — keep the gate unspent

  // A CLEAN bill of health only counts when it came from the session's OWN
  // transcript — the file the Claude Code build running right now is writing. A
  // clean fallback (a previous session's file, possibly from the previous Claude
  // Code version) proves nothing about this build, so the gate stays unspent and
  // the next prompt re-checks, by which time the own file has a turn in it. Spending
  // the gate on that borrowed all-clear was the hole: an upgrade that drifted the
  // shape would sail through the whole session undetected.
  if (!hit.report.findings.length) {
    if (hit.own) served.add(key);
    return null;
  }

  served.add(key);
  console.warn(`[transcript-canary] drift in ${hit.path}: ${hit.report.findings.map(f => f.code).join(", ")}`);
  return formatCanaryWarning(hit.report);
}
