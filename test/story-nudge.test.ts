// Pure halves of the story whisper (src/story-nudge.ts): when it is due, and
// how a later `-(story) #N #M …` names the work it narrates.

import { describe, expect, test } from "bun:test";
import { linkStoryNums, storyNudgeCloserCount, storyWhisper } from "../src/story-nudge";

const L = (en: string) => en;

describe("storyNudgeCloserCount", () => {
  test("two closers are a chapter ending; one is not", () => {
    expect(storyNudgeCloserCount([{ tag: "done" }, { tag: "bug fix" }], {})).toBe(2);
    expect(storyNudgeCloserCount([{ tag: "done" }, { tag: "built" }], {})).toBe(0);
  });
  test("a story already in the batch, or the mute switch, silences it", () => {
    expect(storyNudgeCloserCount([{ tag: "done" }, { tag: "done" }, { tag: "story" }], {})).toBe(0);
    expect(storyNudgeCloserCount([{ tag: "done" }, { tag: "done" }], { DEVLOG_STORY_NUDGE: "0" })).toBe(0);
  });
});

describe("storyWhisper", () => {
  test("says the batch is recorded and names the numbers to narrate", () => {
    const w = storyWhisper(L, 2, [4, 5]);
    expect(w).toContain("They are recorded");
    expect(w).toContain("-(story) #4 #5 <text>");
    expect(w).not.toContain("re-emit");
  });
});

describe("linkStoryNums", () => {
  test("a leading #N #M lead is split off the text", () => {
    expect(linkStoryNums("#4 #5 بدأنا بنهج ففشل")).toEqual({ nums: [4, 5], text: "بدأنا بنهج ففشل" });
    expect(linkStoryNums("#4, #4 text")).toEqual({ nums: [4], text: "text" });
  });
  test("numbers inside the text are not a lead", () => {
    expect(linkStoryNums("بدأنا من #4 ثم انعطفنا")).toEqual({ nums: [], text: "بدأنا من #4 ثم انعطفنا" });
  });
  test("a lead with no text after it keeps the content whole", () => {
    expect(linkStoryNums("#4 #5").text).toBe("#4 #5");
  });
});
