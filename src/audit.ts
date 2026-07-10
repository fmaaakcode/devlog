import { appendFile, mkdir } from "node:fs/promises";
import { DATA_DIR } from "./data";
import { softFail } from "./soft-fail";

// Append-only forensic log for destructive operations (clear / delete / kill /
// stop). The request guard() is the only layer in front of these; if it is ever
// bypassed (an old browser that omits Sec-Fetch-Site, a future regression) or a
// destructive op fires by accident, this JSONL is the only trail to reconstruct
// WHAT happened and from WHERE (host/origin/ua) — R4 blue-team D2.
//
// Best-effort by design: a logging failure must never block or crash the
// operation it records (that would turn telemetry into a denial-of-service).
const AUDIT_FILE = `${DATA_DIR}/audit.jsonl`;

export async function appendAudit(
  op: string,
  req: Request,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const entry = {
      ts: new Date().toISOString(),
      op,
      host: req.headers.get("host") || null,
      origin: req.headers.get("origin") || null,
      sfs: req.headers.get("sec-fetch-site") || null,
      ua: req.headers.get("user-agent") || null,
      ...extra,
    };
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(AUDIT_FILE, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (e) {
    // Never let an audit write break the request it describes — but a failing
    // forensic log must stay observable: this is the only trail for
    // destructive ops, so a blind swallow here means losing evidence with
    // zero signal even in debug mode.
    softFail(`audit.appendAudit(${op})`, e);
  }
}
