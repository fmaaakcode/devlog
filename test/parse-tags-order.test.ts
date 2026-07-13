import { test, expect, describe } from "bun:test";
import { join } from "node:path";

// #231 regression. parse-tags.ts used to handle `-(ask:rules)` in a "Part 0"
// block that exit(2)'d BEFORE the tags were POSTed to the server. A response
// emitting both `-(ask:rules)` and a closure (`-(done)/-(security fix) #N`)
// therefore lost the closure silently — the early exit fired before
// persistence, and no closure-mismatch feedback was produced either. The fix
// relocates the ask:rules handling to run AFTER the /api/tags POST. We pin that
// source-order invariant here (the hook is a side-effectful script with no DOM/
// server harness, so structural assertions are the testable contract).

const SRC = await Bun.file(join(import.meta.dir, "..", "parse-tags.ts")).text();

describe("parse-tags.js exit(2) ordering (#231)", () => {
  test("tags are POSTed before the ask:rules serve can exit(2)", () => {
    const postIdx = SRC.indexOf("const body = JSON.stringify({ cwd, session_id: sessionId, entries: freshEntries, batch_id: batchId });");
    const serveIdx = SRC.indexOf("[devlog standards]");
    expect(postIdx).toBeGreaterThan(-1);
    expect(serveIdx).toBeGreaterThan(-1);
    expect(postIdx).toBeLessThan(serveIdx);
  });

  test("the rule-command handling no longer precedes tag persistence", () => {
    const ruleParseIdx = SRC.indexOf("parseRuleCommands(msg)");
    const postIdx = SRC.indexOf(`fetch(\`\${SERVER}/api/tags\``);
    expect(ruleParseIdx).toBeGreaterThan(-1);
    // The first /api/tags reference is the queue-flush POST; the persistence
    // POST in Part 1 must come before the ask:rules parse.
    expect(postIdx).toBeLessThan(ruleParseIdx);
  });
});
