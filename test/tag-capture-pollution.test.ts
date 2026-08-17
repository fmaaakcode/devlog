// Two ways a reply's ordinary prose became a stored work item.
//
// #805 — a bullet that merely REFERENCES an item was captured as one. Code
// stripping replaces an inline span with spaces of equal length, so
// "- `#793` (todo) — text" reads as the lenient "- (todo)" form after stripping.
// The phantom item #793 in this project's own record came from such a line.
//
// #692 — a body tag that ends a reply keeps swallowing whatever comes next,
// because its content runs to the next tag or to end-of-message. One stored
// `built` reached 959 chars holding three paragraphs of conversation.

import { describe, test, expect } from "bun:test";
import { parseTags, nearMissTags, isRealTagHead } from "../src/tag-parser";
import { unservedMatches, type AskCtx } from "../src/hook-asks";
import { ASK_ROWS } from "../src/hook-ask-rows";

describe("#805 — a prose bullet that mentions a tag is not a tag", () => {
  test("the exact line that minted the phantom #793 stores nothing", () => {
    expect(parseTags("- `#793` (todo) — نص تجريبي")).toEqual([]);
  });

  test("any inline-code span before the head disqualifies it", () => {
    expect(parseTags("- `#N` (bug found) — إشارة داخل شرح")).toEqual([]);
    expect(parseTags("- `x` (done) #5")).toEqual([]);
  });

  test("prose between the bullet and the head disqualifies it too", () => {
    expect(parseTags("- راجع (todo) في الدليل")).toEqual([]);
  });

  test("the lenient forms a human actually slips into still work", () => {
    expect(parseTags("-(todo) صارم").map(t => t.content)).toEqual(["صارم"]);
    expect(parseTags("- (todo) متساهل").map(t => t.content)).toEqual(["متساهل"]);
    expect(parseTags("-  (todo) مسافتان").map(t => t.content)).toEqual(["مسافتان"]);
    expect(parseTags("   -(built) مسافة بادئة").map(t => t.content)).toEqual(["مسافة بادئة"]);
  });

  test("inline code INSIDE a real tag's content is untouched", () => {
    // The 288-tag lesson: content is sliced from the original message, never
    // from the stripped copy. The new head check must not regress that.
    const [t] = parseTags("-(built) عدّلت `src/data.ts` بالكامل");
    expect(t.content).toBe("عدّلت `src/data.ts` بالكامل");
  });
});

describe("#692 — a body tag stops at the first paragraph break", () => {
  test("conversation that follows a build note is not stored with it", () => {
    const msg = "-(built) وصف العمل\n\nتم الإغلاق. جرب الآن وأخبرني لو ظهرت عقبة.";
    expect(parseTags(msg).map(t => t.content)).toEqual(["وصف العمل"]);
  });

  test("several swallowed paragraphs are all dropped", () => {
    const msg = "-(built) وصف\n\nفقرة أولى\n\nفقرة ثانية\n\nفقرة ثالثة";
    expect(parseTags(msg)[0].content).toBe("وصف");
  });

  test("a genuine ADJACENT continuation line survives", () => {
    // The distinction the store supports: real continuations are the next line
    // (a second clause), swallowed replies start their own paragraph.
    const msg = "-(refactor) غُيّر اسم الحزمة\nوالـbinary صار aljsr.exe";
    expect(parseTags(msg)[0].content).toBe("غُيّر اسم الحزمة\nوالـbinary صار aljsr.exe");
  });

  test("`about` keeps its paragraphs — it IS the long description", () => {
    const msg = "-(about) أداة توثيق\n\nالستاك: Bun + TypeScript";
    expect(parseTags(msg)[0].content).toBe("أداة توثيق\n\nالستاك: Bun + TypeScript");
  });

  test("`doc:*` bodies keep their markdown blank lines", () => {
    const msg = "-(doc:report) تقرير\n\n# عنوان\n\nفقرة";
    expect(parseTags(msg)[0].content).toBe("تقرير\n\n# عنوان\n\nفقرة");
  });

  test("headline tags were already single-line and stay that way", () => {
    expect(parseTags("-(todo) بند\nكلام بعده")[0].content).toBe("بند");
  });
});

// The same trap in the OTHER two scanners, found by sweeping after #805 was
// fixed — the sweep hint fired because this class had already recurred twice
// (#580, #681). All three now share one check, `isRealTagHead`.
describe("#805 sweep — every scanner reads the head from the original text", () => {
  test("the near-miss nudge no longer fires on prose that quotes a typo", () => {
    expect(nearMissTags("- `#793` (bulit) — رأس مطبعي داخل جملة")).toEqual([]);
  });

  test("a real typo still gets its correction, in both head forms", () => {
    expect(nearMissTags("-(bulit) وصف")).toEqual([{ head: "bulit", suggestion: "built" }]);
    expect(nearMissTags("- (bulit) وصف")).toEqual([{ head: "bulit", suggestion: "built" }]);
  });

  test("an ask command quoted inside prose does not EXECUTE", async () => {
    // The sharpest of the three: not stored pollution but a real side effect —
    // a line that only quoted an item number ran the command and injected its
    // answer into the turn.
    const row = ASK_ROWS.find(r => String(r.re).includes("ask:open"));
    if (!row) throw new Error("ask:open row not found");
    const ctx = (msg: string) => ({
      msg,
      strippedMsg: msg.replace(/`[^`\n]*`/g, m => " ".repeat(m.length)),
      shouldServeAsk: async () => true,
    }) as unknown as AskCtx;   // unservedMatches reads only these three fields
    expect(await unservedMatches(ctx("- `#793` (ask:open)"), row.re, () => "ask:open")).toHaveLength(0);
    expect(await unservedMatches(ctx("-(ask:open)"), row.re, () => "ask:open")).toHaveLength(1);
    expect(await unservedMatches(ctx("- (ask:open)"), row.re, () => "ask:open")).toHaveLength(1);
  });

  test("an ask ARGUMENT written in backticks reaches the row intact (fourth site of the strip-then-extract defect)", async () => {
    // Detection runs over the stripped copy, but rows read m[1] as the
    // argument — a backticked path/query arrived as spaces and the ask ran
    // empty. Groups are now projected back onto the original text.
    const row = ASK_ROWS.find(r => String(r.re).includes("ask:why"));
    if (!row) throw new Error("ask:why row not found");
    const ctx = (msg: string) => ({
      msg,
      strippedMsg: msg.replace(/`[^`\n]*`/g, m => " ".repeat(m.length)),
      shouldServeAsk: async () => true,
    }) as unknown as AskCtx;
    const hits = await unservedMatches(ctx("-(ask:why) `src/standards.ts`"), row.re, m => `ask:why ${(m[1] || "").trim()}`);
    expect(hits).toHaveLength(1);
    // Backticks are formatting, not argument — the path reaches the API bare.
    expect(hits[0].m[1].trim()).toBe("src/standards.ts");
    expect(hits[0].cmd).toBe("ask:why src/standards.ts");
  });

  test("isRealTagHead itself: whitespace-only gaps pass, anything else fails", () => {
    expect(isRealTagHead("-(todo) x", 0, 1)).toBe(true);
    expect(isRealTagHead("- (todo) x", 0, 2)).toBe(true);
    expect(isRealTagHead("\n  - (todo) x", 0, 5)).toBe(true);
    expect(isRealTagHead("- `#7` (todo) x", 0, 7)).toBe(false);
    expect(isRealTagHead("- راجع (todo) x", 0, 7)).toBe(false);
  });
});
