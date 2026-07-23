// Unit tests for the untagged-session guard's decision core: it must fire on
// exactly one shape — code written this session, zero tags stored, zero tags in
// the current response, first time, not a continuation — and stay silent on
// every neighboring shape (conversation-only sessions, already-tagged sessions,
// the correcting continuation itself).

import { describe, test, expect } from "bun:test";
import { shouldNudgeUntagged, type UntaggedCheckInput } from "../src/untagged-guard";

const firing: UntaggedCheckInput = {
  codeWriteCount: 3,
  trackingWriteCount: 0,
  sessionTagCount: 0,
  turnEntryCount: 0,
  stopHookActive: false,
  alreadyHinted: false,
  disabled: false,
};

describe("shouldNudgeUntagged", () => {
  test("fires on the target shape: code written, zero tags anywhere, first time", () => {
    expect(shouldNudgeUntagged(firing)).toBe(true);
  });

  test("a single code file is enough", () => {
    expect(shouldNudgeUntagged({ ...firing, codeWriteCount: 1 })).toBe(true);
  });

  test("silent when the session wrote no code (conversation-only)", () => {
    expect(shouldNudgeUntagged({ ...firing, codeWriteCount: 0 })).toBe(false);
  });

  test("fires on tracking files alone — the markdown-only Superpowers signature (#676)", () => {
    expect(shouldNudgeUntagged({ ...firing, codeWriteCount: 0, trackingWriteCount: 2 })).toBe(true);
  });

  test("a single tracking file is enough", () => {
    expect(shouldNudgeUntagged({ ...firing, codeWriteCount: 0, trackingWriteCount: 1 })).toBe(true);
  });

  test("silent when the session already stored tags (partial tagging is #558's counter, not this guard)", () => {
    expect(shouldNudgeUntagged({ ...firing, sessionTagCount: 2 })).toBe(false);
  });

  test("silent when the current response carries tags (they just aren't stored yet)", () => {
    expect(shouldNudgeUntagged({ ...firing, turnEntryCount: 1 })).toBe(false);
  });

  test("silent on a hook-blocked continuation (it IS the correction)", () => {
    expect(shouldNudgeUntagged({ ...firing, stopHookActive: true })).toBe(false);
  });

  test("once per session — never repeats after the ack", () => {
    expect(shouldNudgeUntagged({ ...firing, alreadyHinted: true })).toBe(false);
  });

  test("muted via DEVLOG_UNTAGGED_CHECK=0", () => {
    expect(shouldNudgeUntagged({ ...firing, disabled: true })).toBe(false);
  });
});
