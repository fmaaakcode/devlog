// Transient-Windows-lock retry (#781): an AV scanner briefly holding a
// freshly-written file makes rename/append/unlink throw EPERM/EBUSY/EACCES for
// a few dozen ms — one transient lock then surfaced as a spurious 500 on write
// paths under load. Retry those three codes with a short pause; anything else
// (or a lock that survives every attempt — an external terminal/editor hold)
// propagates. Sole retry loop in the codebase: renameWithRetry in server.ts and
// the append/unlink wrappers in event-archive.ts delegate here.
export async function withLockRetry<T>(op: () => Promise<T>, attempts = 6, delayMs = 120): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await op(); }
    catch (e) {
      const code = (e as { code?: string })?.code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= attempts) throw e;
      await Bun.sleep(delayMs);
    }
  }
}
