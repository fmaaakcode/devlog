// Desktop notification for outcomes the USER is waiting on while no turn is
// running — today: the background release (release-autocheck.ts) and its
// post-release chain. Both finish minutes after the model's turn ended, and
// the result used to reach nobody until the next prompt carried it to the
// model; the user had to ask "what happened to the release?".
//
// Windows only (a toast through Windows PowerShell's own WinRT projection — no
// dependency, no installed module). Other platforms are a silent no-op: the
// prompt-time announcement still delivers the outcome there.
//
// The text travels in ENV VARS, never inside the script: a release reason is
// free text, and interpolating it into PowerShell or the toast XML would be an
// injection. The script XML-escapes what it reads.
//
// Fire-and-forget and fail-open: a notification that cannot be shown must
// never fail or delay the release it reports.
// Kill switches: DEVLOG_NOTIFY=0, and NODE_ENV=test unless set to 1.

import { bunSpawn } from "./spawn";
import { currentLang } from "./i18n";

export const notifyDisabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEVLOG_NOTIFY === "0" || (env.NODE_ENV === "test" && env.DEVLOG_NOTIFY !== "1");

export interface Toast { title: string; body: string }

const BODY_MAX = 200;
const clip = (s: string): string => (s.length > BODY_MAX ? `${s.slice(0, BODY_MAX - 1)}…` : s);
const withV = (version: string): string => `v${version.replace(/^v+/i, "")}`;
// A release reason arrives as "vX.Y.Z — reason" once the version is derived.
const reasonOf = (content: string): string => content.replace(/^v?\d+\.\d+\.\d+\S*\s*[—-]\s*/i, "").trim();

/** The toast for a finished background release. Plain status in the user's
 *  language — the check's raw tail stays in the record for the model to read. */
export function releaseToast(
  rec: { project: string; status: string; version?: string; content: string },
  ar: boolean = currentLang() === "ar",
): Toast | null {
  if (rec.status === "checking") return null;
  if (rec.status === "released") {
    const v = withV(rec.version || "");
    return {
      title: ar ? `✓ DevLog — صدر ${v}` : `✓ DevLog — released ${v}`,
      body: clip(`${rec.project}: ${reasonOf(rec.content)}`),
    };
  }
  const why = rec.status === "refused"
    ? (ar ? "الفحص أخضر لكن الإصدار رُفض" : "the check was green but the release was refused")
    : (ar ? "فشل فحص الإصدار" : "the release check failed");
  return {
    title: ar ? "✗ DevLog — الإصدار لم يتم" : "✗ DevLog — release did not happen",
    body: clip(ar
      ? `${rec.project}: ${why}. لم يُسجَّل شيء — أخبر Claude ليقرأ السبب.`
      : `${rec.project}: ${why}. Nothing was recorded — tell Claude to read why.`),
  };
}

/** The toast for a post-release chain that failed AFTER the release was recorded. */
export function postReleaseFailToast(project: string, version: string, step: string, ar: boolean = currentLang() === "ar"): Toast {
  const v = withV(version);
  return {
    title: ar ? `✗ DevLog — خطوة بعد الإصدار ${v} فشلت` : `✗ DevLog — a step after ${v} failed`,
    body: clip(ar
      ? `${project}: الإصدار سُجِّل، لكن خطوة «${step}» فشلت — أخبر Claude ليقرأ السبب.`
      : `${project}: the release was recorded, but the '${step}' step failed — tell Claude to read why.`),
  };
}

// PowerShell's own AppUserModelID: a toast needs a registered app identity to
// be shown, and this one exists on every Windows install.
const APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$esc = [System.Security.SecurityElement]",
  "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>' + $esc::Escape($env:DEVLOG_TOAST_TITLE) + '</text><text>' + $esc::Escape($env:DEVLOG_TOAST_BODY) + '</text></binding></visual></toast>')",
  "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:DEVLOG_TOAST_APP).Show($toast)",
].join("\n");

/** Show a desktop notification. Resolves true when the toast was handed to the
 *  OS; false when disabled, unsupported, or it could not be shown. Never throws. */
export async function notifyDesktop(toast: Toast | null, platform: string = process.platform): Promise<boolean> {
  if (!toast || notifyDisabled() || platform !== "win32") return false;
  try {
    // -EncodedCommand (UTF-16LE base64): no shell quoting between here and PowerShell.
    const encoded = Buffer.from(TOAST_SCRIPT, "utf16le").toString("base64");
    const proc = bunSpawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
      env: { ...process.env, DEVLOG_TOAST_TITLE: toast.title, DEVLOG_TOAST_BODY: toast.body, DEVLOG_TOAST_APP: APP_ID },
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* already gone */ } }, 15_000);
    const code = await proc.exited;
    clearTimeout(timer);
    return code === 0;
  } catch {
    return false;
  }
}
