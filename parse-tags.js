#!/usr/bin/env bun
// DevLog Stop Hook - parses tags from response + syncs plan files
import { readdir, readFile, appendFile, mkdir, rm, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseTags } from "./src/tag-parser.ts";

// Single source for the server base — follows DEVLOG_PORT like data.ts /
// doctor.ts / pre-release-hook.js instead of hardcoding 7777 in six places (R3 P5).
const SERVER = `http://127.0.0.1:${process.env.DEVLOG_PORT || "7777"}`;

// UI language for enforcement messages shown to the user. English by default for
// a global audience; DEVLOG_LANG=ar for Arabic. L(en, ar) picks the variant.
const LANG = (process.env.DEVLOG_LANG || "").trim().toLowerCase().startsWith("ar") ? "ar" : "en";
const L = (en, ar) => (LANG === "ar" ? ar : en);

// Debug log lives next to this script so the project is portable across machines.
const LOG_DIR = join(import.meta.dir, ".devlog");
const LOG_PATH = join(LOG_DIR, "parse-tags.debug.log");
const QUEUE_DIR = join(LOG_DIR, "tag-queue");
// Per-session record of standards commands already served, so the transcript
// re-read (which still contains the command after an exit(2) continuation)
// doesn't reprocess it and loop forever.
const RULES_STATE_DIR = join(LOG_DIR, "rules-state");
await mkdir(LOG_DIR, { recursive: true });
await mkdir(QUEUE_DIR, { recursive: true });
await mkdir(RULES_STATE_DIR, { recursive: true });

// Debug logging is OFF by default (#devops-F2): it ran on EVERY Stop hook with
// no gate and no rotation, so parse-tags.debug.log crept to 4+MB unbounded.
// Opt in with DEVLOG_DEBUG=1. When on, rotate once per invocation (keep one
// generation) so it can't grow without limit either.
const DEBUG = process.env.DEVLOG_DEBUG === "1";
if (DEBUG) {
  try {
    const st = await stat(LOG_PATH);
    if (st.size > 1_000_000) await rename(LOG_PATH, `${LOG_PATH}.1`);
  } catch { /* no log yet, or rotate failed — keep going */ }
}
const log = DEBUG ? (line) => appendFile(LOG_PATH, line + "\n", "utf-8") : () => {};

// Disk queue for /api/tags when the server is unreachable. Without it,
// every Stop hook during a server outage loses tags forever.
async function flushTagQueue() {
  let files;
  try { files = (await readdir(QUEUE_DIR)).filter(f => f.endsWith(".json")).sort(); }
  catch { return; }
  for (const name of files) {
    const fp = join(QUEUE_DIR, name);
    try {
      const body = await readFile(fp, "utf-8");
      const r = await fetch(`${SERVER}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) { await rm(fp); await log(`queue-flush: drained ${name}`); }
      else { await log(`queue-flush: server replied ${r.status}, stopping`); return; }
    } catch (e) { await log(`queue-flush: ${e.message}, stopping`); return; }
  }
}

async function enqueueTags(body) {
  const fname = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`;
  await Bun.write(join(QUEUE_DIR, fname), body);
  await log(`queued to disk: ${fname}`);
}

await log(`=== ${new Date().toISOString()} ===`);

let raw = "";
for await (const chunk of Bun.stdin.stream()) raw += new TextDecoder().decode(chunk);
await log(raw.slice(0, 500));

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  await log(`JSON parse error: ${e.message}`);
  process.exit(0);
}

// Stop hook only delivers `last_assistant_message` (the FINAL text block of
// the turn). Earlier text blocks — those between tool calls — are dropped,
// which loses tags emitted before tool use (e.g. -(doc:plan) at the top of
// a long response). Solution: re-read the transcript JSONL and concatenate
// every assistant text block since the last user message. Falls back to
// last_assistant_message if the transcript can't be read.
async function readTurnFromTranscript(transcriptPath) {
  if (!transcriptPath) return "";
  try {
    const content = await readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    let buf = "";
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const role = obj.message?.role || obj.role;
      const c = obj.message?.content ?? obj.content;
      if (role === "user") {
        // tool_result blocks ride on role="user" but are NOT a real turn
        // boundary — they're the model's tool output during the same turn.
        // Only reset on a genuine user message (string content or text blocks).
        const isToolResultOnly = Array.isArray(c) && c.length > 0
          && c.every(b => b?.type === "tool_result");
        if (!isToolResultOnly) buf = "";
        continue;
      }
      if (role !== "assistant") continue;
      if (typeof c === "string") {
        buf += "\n" + c;
      } else if (Array.isArray(c)) {
        for (const block of c) {
          if (block?.type === "text" && typeof block.text === "string") {
            buf += "\n" + block.text;
          }
        }
      }
    }
    return buf.trim();
  } catch (e) {
    await log(`transcript read error: ${e.message}`);
    return "";
  }
}

const transcriptMsg = await readTurnFromTranscript(data.transcript_path);
const msg = transcriptMsg || data.last_assistant_message || "";
const cwd = data.cwd || "";
const sessionId = data.session_id || "";
// True when this Stop was itself triggered by a previous hook exit(2)
// continuation — used to avoid an infinite enforcement loop.
const stopHookActive = data.stop_hook_active === true;
await log(`cwd=${JSON.stringify(cwd)} session_id=${JSON.stringify(sessionId)} msg_len=${msg.length} source=${transcriptMsg ? "transcript" : "last_assistant_message"}`);
await log(`msg_tail=${JSON.stringify(msg.slice(-300))}`);

// === Part 1: Parse tags ===
if (msg) {
  // Tag parsing (allowed-list + regex + noise filters) is shared with the
  // server and the test suite via src/tag-parser.ts — single source of truth.
  // It used to be duplicated here byte-for-byte (org-audit R2 #1), so the
  // tested copy and the production copy could silently diverge.
  const entries = parseTags(msg);
  await log(`matches=${JSON.stringify(entries.map(e => [e.tag, e.breaking, e.content]))} (count ${entries.length})`);

  if (entries.length) {

    // === Release guard (strict) ===
    // If this response emits `-(release)`, refuse to persist ANY tag unless
    // open-items count is zero. Open = todos, bugs, security, plan steps —
    // anything not yet closed. User policy: no release ships with any open
    // work item, period. Address by emitting -(done)/-(dropped)/-(bug fix)/
    // -(security fix) for each #N first, OR set DEVLOG_RELEASE_GUARD=0 for
    // an explicit one-off bypass.
    const releaseEntry = entries.find(e => e.tag === "release");
    if (releaseEntry && cwd && process.env.DEVLOG_RELEASE_GUARD !== "0") {
      try {
        const openRes = await fetch(`${SERVER}/api/open-items?cwd=${encodeURIComponent(cwd)}`, {
          signal: AbortSignal.timeout(3000),
        });
        const { items: rawItems = [] } = openRes.ok ? await openRes.json() : { items: [] };
        // Apply in-flight closures from THIS response. Type-matched: done/
        // dropped close todo+plan-step, bug fix closes bug found, security
        // fix closes security*. Lets Claude close items AND release in the
        // same turn (otherwise the user is forced to split into two turns).
        const inflight = { done: new Set(), bugFix: new Set(), secFix: new Set() };
        for (const e of entries) {
          const nums = [...((e.content || "").matchAll(/#(\d+)/g))].map(m => parseInt(m[1], 10));
          if (!nums.length) continue;
          if (e.tag === "done" || e.tag === "dropped") for (const n of nums) inflight.done.add(n);
          else if (e.tag === "bug fix") for (const n of nums) inflight.bugFix.add(n);
          else if (e.tag === "security fix") for (const n of nums) inflight.secFix.add(n);
        }
        const items = rawItems.filter(it => {
          if (it.tag === "todo" || it.tag === "plan-step") return !inflight.done.has(it.num);
          if (it.tag === "bug found") return !inflight.bugFix.has(it.num);
          if (it.tag === "security" || it.tag === "security:own" || it.tag === "security:dep") return !inflight.secFix.has(it.num);
          return true;
        });
        if (items.length > 0) {
          const byTag = {};
          for (const it of items) (byTag[it.tag] ||= []).push(it);
          const out = [];
          out.push("════════ DevLog Release Guard ════════");
          out.push(`-(release) ${releaseEntry.content.slice(0, 120)}`);
          out.push("");
          out.push(L(
            `🛑 ${items.length} open item(s) — a release cannot ship while any item is open:`,
            `🛑 ${items.length} مهمة مفتوحة — لا يجوز إصدار release بوجود أي مهمة مفتوحة:`));
          for (const [tag, arr] of Object.entries(byTag)) {
            out.push(`  ${tag} (${arr.length}):`);
            for (const it of arr.slice(0, 20)) {
              const plan = it.planTitle ? ` [plan: ${it.planTitle}]` : "";
              out.push(`    · #${it.num} ${(it.content || "").slice(0, 80)}${plan}`);
            }
            if (arr.length > 20) out.push(L(`    ... +${arr.length - 20} more`, `    ... +${arr.length - 20} أخرى`));
          }
          out.push("");
          out.push(L(
            "Fix: close every #N with -(done) / -(dropped) / -(bug fix) / -(security fix) in your next response,",
            "الإصلاح: أَغلق كل #N بـ -(done) / -(dropped) / -(bug fix) / -(security fix) في الرد التالي،"));
          out.push(L(
            "then re-emit -(release). Or bypass once with DEVLOG_RELEASE_GUARD=0.",
            "ثم أعد إصدار -(release). أو تجاوز مؤقتاً بـ DEVLOG_RELEASE_GUARD=0."));
          out.push("");
          out.push(L("✗ The release tag was NOT recorded.", "✗ الـrelease tag لم يُسجَّل."));
          out.push("══════════════════════════════════════");
          process.stderr.write(out.join("\n") + "\n");
          await log(`release-guard BLOCKED: open_items=${items.length}`);
          process.exit(2);
        }
      } catch (e) {
        await log(`release-guard error: ${e.message}`);
      }
    }

    const body = JSON.stringify({ cwd, session_id: sessionId, entries });
    // Drain any prior queued tags first (preserves chronological order).
    await flushTagQueue();
    try {
      const r = await fetch(`${SERVER}/api/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(5000),
      });
      const respBody = await r.text();
      await log(`POST result: ${r.status} ${respBody.slice(0, 200)}`);
      if (!r.ok) await enqueueTags(body);
      else {
        // Release response: feed the outcome back so Claude knows DevLog
        // processed the release (version bumped, HTML/changelog written) and
        // can continue post-release steps (e.g. build) WITHOUT stopping to ask
        // the user. The server only returns a result for a newly-stored release
        // tag — a re-emit dedups to null, so this exit(2) fires once (no loop).
        try {
          const resp = JSON.parse(respBody);
          // Release downgrade rejected wholesale: the release was OLDER than the
          // latest one, so the server stored nothing (no tag/HTML/index/bump).
          // Tell Claude with exit(2) so it re-issues a correct version.
          if (resp.releaseDowngrade) {
            const dg = resp.releaseDowngrade;
            const out = [
              "════════ DevLog Release Rejected ════════",
              L(`🛑 Version ${dg.version} is older than the latest release (${dg.latest}) — rejected entirely.`,
                `🛑 الإصدار ${dg.version} أقدم من آخر إصدار (${dg.latest}) — رُفض بالكامل.`),
              L("Nothing was recorded: no tag, no HTML, no index, no version bump.",
                "لم يُسجَّل أي شيء: لا وسم، لا HTML، لا index، ولا رفع نسخة."),
              "",
              L(`Release a version newer than ${dg.latest}, or double-check the number.`,
                `أصدر نسخة أحدث من ${dg.latest}، أو تأكّد من الرقم.`),
              "═════════════════════════════════════════",
            ].join("\n");
            process.stderr.write(`\n${out}\n`);
            await log(`release-downgrade rejected: ${dg.version} < ${dg.latest}`);
            process.exit(2);
          }
          // Open-items guard fired on the SERVER (defense in depth). Reached when
          // the pre-send guard above was bypassed — server unreachable at pre-check
          // (fail-open), un-numbered open items, or the hook not wired. The server
          // stored nothing; tell Claude to close the items, then re-release.
          if (resp.releaseBlocked) {
            const items = resp.releaseBlocked.openItems || [];
            const byTag = {};
            for (const it of items) (byTag[it.tag] ||= []).push(it);
            const out = ["════════ DevLog Release Blocked ════════",
              L(`🛑 ${items.length} open item(s) — the release was NOT recorded (no tag, no HTML, no version bump):`,
                `🛑 ${items.length} مهمة مفتوحة — لم يُسجَّل الإصدار (لا وسم، لا HTML، لا رفع نسخة):`)];
            for (const [tag, arr] of Object.entries(byTag)) {
              out.push(`  ${tag} (${arr.length}):`);
              for (const it of arr.slice(0, 20)) {
                const ref = typeof it.num === "number" ? `#${it.num}` : `«${(it.content || "").slice(0, 40)}»`;
                const plan = it.planTitle ? ` [plan: ${it.planTitle}]` : "";
                out.push(`    · ${ref} ${(it.content || "").slice(0, 80)}${plan}`);
              }
              if (arr.length > 20) out.push(L(`    ... +${arr.length - 20} more`, `    ... +${arr.length - 20} أخرى`));
            }
            out.push("", L("Close every item with -(done)/-(dropped)/-(bug fix)/-(security fix) (by number, or by text for items with no #N),",
              "أَغلِق كل عنصر بـ -(done)/-(dropped)/-(bug fix)/-(security fix) (بالرقم، أو بالنص للعناصر بلا #N)،"),
              L("then re-emit -(release). Or bypass with DEVLOG_RELEASE_GUARD=0.",
                "ثم أعد إصدار -(release). أو تجاوز بـ DEVLOG_RELEASE_GUARD=0."),
              "═════════════════════════════════════════");
            process.stderr.write(`\n${out.join("\n")}\n`);
            await log(`release-blocked (server): open_items=${items.length}`);
            process.exit(2);
          }
          // Release rollback outcome (QA #2): undoing a release reverses its
          // effects; report them so the manifest state is never silently out of
          // sync. Informational — NO exit(2).
          if (resp.rollback) {
            const rb = resp.rollback;
            const manifest = rb.restoredTo
              ? L(`manifest restored to ${rb.restoredTo}`, `استُرجِع المانيفست إلى ${rb.restoredTo}`)
              : L("manifest not restored (no prior reference) — check manually if needed",
                  "لم يُسترجَع المانيفست (لا مرجع سابق) — تحقّق يدوياً إن لزم");
            process.stderr.write(
              `\n[devlog rollback]\n${L(`↩ Release ${rb.version} removed`, `↩ أُزيل الإصدار ${rb.version}`)}: ${manifest}` +
              `${rb.htmlDeleted ? L(", page deleted", "، حُذِفت الصفحة") : ""}${rb.indexRebuilt ? L(", index rebuilt", "، أُعيد بناء الفهرس") : ""}.\n`);
            await log(`rollback: ${rb.version} restoredTo=${rb.restoredTo}`);
          }
          // Positive closure confirmation (#228): echo what each `#N` closure
          // actually closed, text included. Informational only — NO exit(2), so
          // it never forces an extra turn; it just surfaces alongside any other
          // feedback. The text lets Claude catch a wrong-but-compatible number
          // (closed #229 when #228 was meant — a slip the mismatch check can't
          // see because both are open todos).
          if (Array.isArray(resp.closed) && resp.closed.length) {
            const lines = resp.closed.map(c => L(`✓ closed #${c.num} — ${c.text}`, `✓ أُغلق #${c.num} — ${c.text}`));
            process.stderr.write(`\n[devlog closure]\n${lines.join("\n")}\n`);
            await log(`closure-confirm: ${resp.closed.map(c => c.num).join(", ")}`);
          }
          // Optional verify nudge (#232): closed something without running tests
          // this session. Informational only — NO exit(2), never blocks. Mute
          // with DEVLOG_VERIFY_HINT=0.
          if (resp.verifyHint && Array.isArray(resp.verifyHint.closers) && resp.verifyHint.closers.length
              && process.env.DEVLOG_VERIFY_HINT !== "0") {
            const verbs = [...new Set(resp.verifyHint.closers.map(c => c.tag))].join("/");
            process.stderr.write(
              `\n[devlog verify]\n${L(
                `💡 You closed (${verbs}) without running any test this session. "Verified" = observed evidence (a passing test in the conversation), not reading the code. Run the test to confirm.`,
                `💡 أغلقتَ (${verbs}) بلا تشغيل أي اختبار في هذه الجلسة. «التحقّق» = دليل مُلاحَظ (اختبار ناجح في المحادثة)، لا قراءة الكود. شغّل الاختبار للتأكيد.`)}\n`);
            await log(`verify-hint: ${resp.verifyHint.closers.length} closer(s), no test run`);
          }
          // Closure mismatch: Claude closed an item that won't actually close —
          // wrong verb for an open item (`-(done)` on a bug), or a #N matching no
          // open item (typo'd / already-closed number). The server skipped the
          // junk tag; tell Claude how to fix it. Fires once — a correct closure
          // produces no hint next turn (no loop). Checked before release so
          // closures get fixed first (the release-guard would block anyway).
          if (Array.isArray(resp.closureHints) && resp.closureHints.length) {
            const lines = resp.closureHints.map(h =>
              h.kind === "no-match"
                ? L(`· #${h.num} matches no open item — check the number (closure not applied).`,
                    `· #${h.num} لا يطابق أي عنصر مفتوح — تحقّق من الرقم (الإغلاق لم يُطبَّق).`)
                : L(`· #${h.num} is a «${h.openerTag}» — close it with -(${h.suggested}) #${h.num}, not -(${h.usedCloser}).`,
                    `· #${h.num} نوعه «${h.openerTag}» — أغلِقه بـ-(${h.suggested}) #${h.num}، لا -(${h.usedCloser}).`));
            const out = [
              "════════ DevLog Closure Mismatch ════════",
              L(`⚠ ${resp.closureHints.length} closure(s) not recorded (closed nothing):`,
                `⚠ ${resp.closureHints.length} إغلاق لم يُسجَّل (لم يُغلِق شيئاً):`),
              ...lines,
              "",
              L("Fix the number or the verb above, then re-close.",
                "صحّح الرقم أو الـverb أعلاه ثم أعد الإغلاق."),
              "═════════════════════════════════════════",
            ].join("\n");
            process.stderr.write(`\n${out}\n`);
            await log(`closure-mismatch: served ${resp.closureHints.length}`);
            process.exit(2);
          }
          if (resp.release) {
            const rel = resp.release;
            const sep = L(", ", "، ");
            const bumps = (rel.bumped || []).map(u => `${u.file} ${u.from}→${u.to}`).join(sep) || L("no manifest to bump", "لا مانيفست لرفعه");
            const downgrades = (rel.rejected || []).map(u => `${u.file} ${u.current}→${u.attempted}`).join(sep);
            const out = [
              "════════ DevLog Release ════════",
              L(`✓ Release ${rel.version} recorded in DevLog.`, `✓ الإصدار ${rel.version} سُجِّل في DevLog.`),
              L(`Version bump: ${bumps}`, `رفع النسخة: ${bumps}`),
              ...(downgrades ? [L(`⚠ Downgrade refused (manifest is newer): ${downgrades}`, `⚠ رُفض تنزيل النسخة (المانيفست أحدث): ${downgrades}`)] : []),
              `HTML/changelog: ${rel.htmlGenerated ? L("generated ✓", "أُنشئ ✓") : L("not generated", "لم يُنشأ")}`,
              "",
              L("Continue post-release steps (e.g. building the output) without waiting for the user.",
                "تابع خطوات ما بعد الإصدار (مثل بناء الناتج) بدون انتظار المستخدم."),
              "════════════════════════════════",
            ].join("\n");
            process.stderr.write(`\n${out}\n`);
            await log(`release-response: served ${rel.version}`);
            process.exit(2);
          }
        } catch (e) { await log(`release-response parse error: ${e.message}`); }
      }
    } catch (e) {
      await log(`POST error: ${e.message}`);
      await enqueueTags(body);
    }

    // === Closure check ===
    // After tags are persisted, ask the server for items STILL open. Any
    // `-(built)`/`-(refactor)` in this response that fuzzy-matches an open
    // item without a closure → emit warning to stderr (exit 2 forces Claude
    // to address it before the turn ends). Skip if DEVLOG_CLOSURE_CHECK=0.
    if (cwd && process.env.DEVLOG_CLOSURE_CHECK !== "0") {
      try {
        const openRes = await fetch(`${SERVER}/api/open-items?cwd=${encodeURIComponent(cwd)}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (openRes.ok) {
          const { items = [] } = await openRes.json();
          const mod = await import("./src/closure-check.ts");
          const result = mod.checkClosures(entries, items);
          await log(`closure-check: unclosed=${result.unclosed.length} warnings=${result.warnings.length}`);
          if (result.unclosed.length || result.warnings.length) {
            const msg = mod.formatClosureMessage(result);
            process.stderr.write(`\n[devlog closure-check]\n${msg}\n`);
            if (result.unclosed.length) {
              // Exit 2: Claude sees stderr as feedback and must respond again.
              process.exit(2);
            }
          }
        }
      } catch (e) {
        await log(`closure-check error: ${e.message}`);
      }
    }
  }
}

// === Part 1.5: Standards rule commands (ask:rules / rule:add / rule:new / rules:list / rule:rm) ===
// Served in-turn via stderr + exit(2) — the same continuation mechanism the
// closure-check uses. The standards library lives on local disk
// (~/.claude/standards), so this works even when the server is down. A
// per-session state file dedups commands across exit(2) continuations.
//
// ORDER MATTERS (#231): this runs AFTER Part 1 has POSTed the tags. It used to
// run first (Part 0) and exit(2) on the first ask:rules — so a response that
// emitted both `-(ask:rules)` and a closure (e.g. `-(security fix) #N`) lost the
// closure silently: the early exit fired before persistence, and no closure-
// mismatch feedback was produced either. Persist first, serve rules second.
if (msg) {
  try {
    const { parseRuleCommands, runRuleCommands } = await import("./src/standards.ts");
    const cmds = parseRuleCommands(msg);
    if (cmds.length) {
      const safeSid = (sessionId || "nosession").replace(/[^a-zA-Z0-9_-]/g, "_");
      const stateFile = join(RULES_STATE_DIR, `${safeSid}.json`);
      let served = [];
      try { served = JSON.parse(await readFile(stateFile, "utf-8")); } catch {}
      const servedSet = new Set(served);
      const fresh = cmds.filter(c => !servedSet.has(c.key));
      if (fresh.length) {
        const { output: raw } = await runRuleCommands(fresh, cwd);
        // Resolve {{latest:lang}}/{{edition:lang}} to live toolchain values so a
        // manual -(ask:rules) gets the same fresh numbers the auto-gate injects.
        const { latestToolchain } = await import("./src/registry.ts");
        const { resolveContentTemplates } = await import("./src/standards.ts");
        const output = await resolveContentTemplates(raw, latestToolchain);
        for (const c of fresh) servedSet.add(c.key);
        await Bun.write(stateFile, JSON.stringify([...servedSet]));
        await log(`rule-commands: served ${fresh.length} [${fresh.map(c => c.cmd).join(", ")}]`);
        if (output.trim()) {
          // exit(2): Claude sees stderr as feedback and continues this turn
          // with the rules/confirmation in context.
          process.stderr.write(`\n[devlog standards]\n${output}\n`);
          process.exit(2);
        }
      }
    }
  } catch (e) {
    await log(`rule-commands error: ${e.message}`);
  }
}

// === Part 1.5b: -(audit) — on-demand vuln report, served like -(ask:rules) ===
// Claude writes `-(audit)` (or `-(audit) <pkg>`) and gets a full vuln report for the
// current project back THIS turn via stderr+exit(2). Not a logged tag. Heavy lifting
// (tree scan + OSV) lives in the server's /api/audit; here we just relay.
//
// Re-runnable across turns (an audit tool MUST be — you scan, fix, scan again). The
// loop guard is `stopHookActive`, NOT a per-session dedup: we serve ONLY on a fresh
// stop. After our exit(2) the model continues and the next Stop has
// stop_hook_active=true (the message still contains `-(audit)`) — we skip it, so no
// infinite loop. A new user turn is a fresh stop again, so the next `-(audit)` fires.
if (msg && cwd && !stopHookActive) {
  try {
    // Strip fenced + inline code first (same as parseRuleCommands) so an `-(audit)`
    // shown as an EXAMPLE inside ``` ``` doesn't trigger a real scan.
    const stripped = msg
      .replace(/```[\s\S]*?```/g, s => " ".repeat(s.length))
      .replace(/`[^`\n]*`/g, s => " ".repeat(s.length));
    const m = stripped.match(/^[ \t]*-\(audit\)(?:[ \t]+([^\n]+))?[ \t]*$/m);
    if (m) {
      const arg = (m[1] || "").trim();
      const qs = `cwd=${encodeURIComponent(cwd)}${arg ? `&pkg=${encodeURIComponent(arg)}` : ""}`;
      const r = await fetch(`${SERVER}/api/audit?${qs}`, { signal: AbortSignal.timeout(120000) });
      if (r.ok) {
        const report = await r.text();
        await log(`audit: served (${arg || "all"})`);
        if (report.trim()) {
          process.stderr.write(`\n[devlog audit]\n${report}\n`);
          process.exit(2);
        }
      } else {
        await log(`audit: server replied ${r.status}`);
      }
    }
  } catch (e) {
    await log(`audit error: ${e.message}`);
  }
}

// === Part 1.6: Standards enforcement (force the pull) ===
// DISABLED (user directive 2026-06-24): the system no longer nags Claude at Stop
// time for "wrote code without pulling a standard". Enforcement now happens ONLY
// at write time via the rust edition/version checker (pre-standards.js). The block
// below stays INTACT — flip STANDARDS_PULL_ENFORCEMENT to true to restore the
// retrospective pull-nag.
const STANDARDS_PULL_ENFORCEMENT = false;
if (STANDARDS_PULL_ENFORCEMENT && cwd && sessionId && process.env.DEVLOG_STANDARDS_CHECK !== "0") {
  try {
    const { scanCatalog, shouldEnforceStandards, isCodeWrite, isEnforcementDisabled, inferCategories, coveredCategories } = await import("./src/standards.ts");
    // Per-project opt-out (dashboard injection window writes .devlog/standards-off).
    const disabled = isEnforcementDisabled(cwd);
    if (disabled) await log("standards-check: disabled for this project");
    const catalog = await scanCatalog(cwd);
    const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    let served = [];
    try { served = JSON.parse(await readFile(join(RULES_STATE_DIR, `${safeSid}.json`), "utf-8")); } catch {}

    let codeWrites = [];
    // Only pay for the session-changes query when a block is otherwise possible.
    if (!disabled && catalog.length && !stopHookActive) {
      try {
        const r = await fetch(`${SERVER}/api/changes/session?session_id=${encodeURIComponent(sessionId)}`, {
          signal: AbortSignal.timeout(3000),
        });
        const { items = [] } = r.ok ? await r.json() : { items: [] };
        codeWrites = items.filter(it => isCodeWrite(it.file_path));
      } catch (e) { await log(`standards-check changes error: ${e.message}`); }
    }

    // Relevance-aware: only the catalog categories the written files actually NEED
    // (language/design/cross-cutting, ∩ catalog) and that weren't pulled or
    // auto-served. A C++-only session with no `cpp` category yields ∅ → no nag.
    const names = catalog.map(c => c.category);
    const covered = new Set(coveredCategories(served).map(c => c.toLowerCase()));
    const relevant = new Set();
    for (const it of codeWrites) {
      for (const cat of inferCategories(it.file_path, names)) {
        if (!covered.has(cat.toLowerCase())) relevant.add(cat.toLowerCase());
      }
    }

    if (shouldEnforceStandards({
      catalogCount: catalog.length,
      relevantUncovered: relevant.size,
      stopHookActive,
    })) {
      const need = [...relevant].join(" ");
      const out = [
        "════════ DevLog Standards Check ════════",
        L(`🛑 Code was written this session (${codeWrites.length} file(s)) without pulling the applicable standard.`,
          `🛑 كُتب كود في هذي الجلسة (${codeWrites.length} ملف) دون سحب المعيار المنطبق عليه.`),
        "",
        L(`Applicable uncovered categories: ${need}`, `التصنيفات المنطبقة غير المُغطّاة: ${need}`),
        L(`Do now: -(ask:rules) ${need}, review the code against them, and apply what's needed before finishing.`,
          `افعل الآن: -(ask:rules) ${need}، راجع الكود ضدّها، وطبّق ما يلزم قبل الإنهاء.`),
        L("(disable once: DEVLOG_STANDARDS_CHECK=0)", "(تعطيل لمرة واحدة: DEVLOG_STANDARDS_CHECK=0)"),
        "════════════════════════════════════════",
      ].join("\n");
      process.stderr.write(`\n${out}\n`);
      await log(`standards-check BLOCKED: code_writes=${codeWrites.length}, relevantUncovered=${[...relevant].join(",")}`);
      process.exit(2);
    }
  } catch (e) {
    await log(`standards-check error: ${e.message}`);
  }
}

// === Part 1.7: Dependency freshness (enforces the `dependencies` standard) ===
// Claude can't reach crates.io/npm to verify the ">7 days old" rule (it said so
// in the wild). The server can — so when a manifest changed this session, ask it
// and feed any violations back via exit(2) so Claude fixes the pin before ending.
if (cwd && sessionId && !stopHookActive && process.env.DEVLOG_STANDARDS_CHECK !== "0") {
  try {
    const { isEnforcementDisabled, isAcked } = await import("./src/standards.ts");
    if (!isEnforcementDisabled(cwd)) {
      const r0 = await fetch(`${SERVER}/api/changes/session?session_id=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(3000) });
      const { items = [] } = r0.ok ? await r0.json() : { items: [] };
      const MANIFEST = /(?:^|[\\/])(Cargo\.toml|package\.json|go\.mod|pyproject\.toml|requirements\.txt|composer\.json)$/i;
      if (items.some(it => MANIFEST.test(it.file_path || ""))) {
        const r1 = await fetch(`${SERVER}/api/dep-freshness?cwd=${encodeURIComponent(cwd)}`, { signal: AbortSignal.timeout(10000) });
        const { violations: allViolations = [] } = r1.ok ? await r1.json() : { violations: [] };
        // Drop deps the developer marked intentional (P5): `dep:<name>`.
        const violations = allViolations.filter(v => !isAcked(cwd, "dep", v.name));
        // Dedup per session by violation signature so we nag once, not every turn.
        const safeSid = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const sf = join(RULES_STATE_DIR, `${safeSid}.json`);
        let served = [];
        try { served = JSON.parse(await readFile(sf, "utf-8")); } catch {}
        const sig = "dep-fresh|" + violations.map(v => `${v.name}@${v.installed}`).sort().join(",");
        if (violations.length && !served.includes(sig)) {
          served.push(sig);
          await Bun.write(sf, JSON.stringify(served));
          const lines = violations.map(v => v.kind === "behind"
            ? L(`· ${v.name} ${v.installed} → use ${v.suggest} (a newer mature version is available)`,
                `· ${v.name} ${v.installed} → استخدم ${v.suggest} (إصدار أحدث ناضج متاح)`)
            : L(`· ${v.name} ${v.installed} (latest ${v.latest} is ${v.ageDays} days old < 7) → use ${v.suggest}`,
                `· ${v.name} ${v.installed} (الأحدث ${v.latest} عمره ${v.ageDays} يوم < 7) → استخدم ${v.suggest}`));
          const out = [
            "════════ DevLog Dependency Check ════════",
            L(`⚠ ${violations.length} dependency(ies) violate the dependencies standard:`,
              `⚠ ${violations.length} مكتبة تخالف معيار dependencies:`),
            ...lines,
            "",
            L("Install the suggested version (the newest mature release published more than 7 days ago), or confirm the exception reason to the user before finishing.",
              "ثبّت النسخة المقترَحة (أحدث إصدار ناضج مرّ على نشره أكثر من 7 أيام)، أو أكّد للمستخدم سبب الاستثناء قبل الإنهاء."),
            L(`(intentional? confirm with ${violations.map(v => `-(rule:ack) dep:${v.name}`).join(" / ")})`,
              `(متعمّد؟ أكّد بـ ${violations.map(v => `-(rule:ack) dep:${v.name}`).join(" / ")})`),
            L("(disable: DEVLOG_STANDARDS_CHECK=0)", "(تعطيل: DEVLOG_STANDARDS_CHECK=0)"),
            "═════════════════════════════════════════",
          ].join("\n");
          process.stderr.write(`\n${out}\n`);
          await log(`dep-freshness BLOCKED: ${violations.length} violations`);
          process.exit(2);
        }
      }
    }
  } catch (e) {
    await log(`dep-freshness error: ${e.message}`);
  }
}

// === Part 2: Session summary (best-effort, fire-and-forget) ===
// Lets the dashboard surface "this session: 3 files, +120/-30, 4 tags, 25 min"
// without each project having to compute it from raw events.
if (sessionId && cwd) {
  try {
    await fetch(`${SERVER}/api/session-summary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, session_id: sessionId }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    await log(`session-summary POST error: ${e.message}`);
  }
}

// === Part 3: Sync plan files ===
// Parallel POSTs with a short timeout. Sequential awaits + 5s timeout each
// caused N×5s freezes in the Stop hook when the server was down (Bug QA #1).
const plansDir = join(homedir(), ".claude", "plans");
try {
  const files = await readdir(plansDir);
  const mdFiles = files.filter(f => f.endsWith(".md"));
  await Promise.allSettled(mdFiles.map(async (name) => {
    const fp = join(plansDir, name);
    try {
      const content = await readFile(fp, "utf-8");
      if (!content.trim()) return;
      await fetch(`${SERVER}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, content, file_path: fp }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {}
  }));
} catch {}
