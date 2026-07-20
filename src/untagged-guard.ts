// The untagged-session guard's decision core (pure, hook-agnostic). Closes the
// structural silent-omission hole exposed by the Superpowers coexistence
// incident (2026-07-20 report `declaration-fragility`): a competing plugin can
// monopolize the model's attention so it writes code and never emits a single
// tag — and nothing mechanical objected. The existing detection (#434/#558) is
// retrospective, passive and human-facing (a dashboard counter after the
// session dies); this guard is the in-session counterpart: it speaks INTO the
// model's context at Stop time, once per session, while correction is still
// possible.
//
// Deliberately narrow so conversation-only sessions never see it:
//   · fires only when actual CODE files were written this session
//   · only when the session stored ZERO tags AND this response carries none
//   · once per session (ledger flag, acked BEFORE the block — install-gate
//     pattern — so a crash can't re-fire it), never a blocking loop
//   · stop_hook_active continuations are exempt (they ARE the correction)
//   · mute with DEVLOG_UNTAGGED_CHECK=0
// This is a reminder, not proof of honest tagging — a lazy generic tag defeats
// it. Truthfulness is the verification loop's job (سجّل→افرض→تحقّق), not this
// guard's.

export interface UntaggedCheckInput {
  /** Distinct code files (isCodeWrite) changed/created this session. */
  codeWriteCount: number;
  /** Tags already stored server-side for this session. */
  sessionTagCount: number;
  /** Tag entries parsed from the CURRENT response. */
  turnEntryCount: number;
  /** True when this Stop is itself a hook-blocked continuation. */
  stopHookActive: boolean;
  /** Ledger flag: the guard already spoke this session. */
  alreadyHinted: boolean;
  /** DEVLOG_UNTAGGED_CHECK=0 opt-out. */
  disabled: boolean;
}

export function shouldNudgeUntagged(i: UntaggedCheckInput): boolean {
  if (i.disabled || i.stopHookActive || i.alreadyHinted) return false;
  if (i.turnEntryCount > 0 || i.sessionTagCount > 0) return false;
  return i.codeWriteCount >= 1;
}
