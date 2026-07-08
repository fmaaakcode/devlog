// Static / file-serving routes, extracted from server.ts (report #3: decompose
// the 2k-line route object). These handlers serve HTML pages, whitelisted
// assets, project files (with symlink-safe traversal checks), and release pages
// — a cohesive group whose only server-local dependencies are the asset-mode
// flags and the HTML responder, injected via `deps` so this module stays free of
// server internals (and free of an import cycle back into server.ts).

import { STATIC_HTML, STATIC_ASSETS } from "./static-assets";
import { loadData } from "./data";
import { pathsEqual, isPathInside, normalizeSlashes } from "./path-utils";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { currentLang } from "./i18n";

const L = <T>(en: T, ar: T): T => (currentLang() === "ar" ? ar : en);
// These handlers only read params/url (never a JSON body), so Bun's routed
// request type is enough — no `any`-typed json() override needed.
type ApiReq = Bun.BunRequest;

export interface StaticRouteDeps {
  htmlResponse: (file: unknown) => Response;
  DEV_ASSETS: boolean;
  ASSET_ROOT: string;
}

/** Build the static/viewer route group. Spread into server.ts's routeDefs. */
export function makeStaticRoutes({ htmlResponse, DEV_ASSETS, ASSET_ROOT }: StaticRouteDeps): Record<string, unknown> {
  return {
    "/": async () => DEV_ASSETS
      ? htmlResponse(Bun.file(`${ASSET_ROOT}/dashboard.html`))
      : htmlResponse(STATIC_HTML["dashboard.html"]),

    "/stack-map.html": async () => DEV_ASSETS
      ? htmlResponse(Bun.file(`${ASSET_ROOT}/stack-map.html`))
      : htmlResponse(STATIC_HTML["stack-map.html"]),

    "/features.html": async () => DEV_ASSETS
      ? htmlResponse(Bun.file(`${ASSET_ROOT}/features.html`))
      : htmlResponse(STATIC_HTML["features.html"]),

    "/assets/:file": async (req: ApiReq) => {
      const name = req.params.file;
      // Only allow simple filenames; reject anything with path separators or traversal
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return new Response("Bad request", { status: 400 });
      // STATIC_ASSETS is the allowlist + MIME source. Dev reads the file from
      // disk for live edits; a compiled binary serves the embedded bytes.
      const asset = STATIC_ASSETS[name];
      if (!asset) return new Response("Not found", { status: 404 });
      const body = DEV_ASSETS
        ? Bun.file(`${ASSET_ROOT}/assets/${name}`)
        : ("text" in asset ? asset.text : Bun.file(asset.file));
      return new Response(body, { headers: { "Content-Type": asset.mime } });
    },

    // Read a project file's content for the dashboard hover-preview + "open in
    // new window". Security: the path must resolve inside a tracked project (no
    // `..` traversal), and the body is served as text/plain + nosniff so an
    // .html/.svg project file can never execute in the opened tab.
    "/api/file": async (req: ApiReq) => {
      const url = new URL(req.url);
      const raw = normalizeSlashes(url.searchParams.get("path"));
      if (!raw || raw.includes("..")) return new Response("Bad request", { status: 400 });
      const data = await loadData();
      const dir = raw.slice(0, raw.lastIndexOf("/"));
      const inside = Object.values(data.projects).some(p => {
        const pp = normalizeSlashes(p.path);
        return !!pp && (pathsEqual(dir, pp) || isPathInside(pp, raw));
      });
      if (!inside) return new Response("Forbidden", { status: 403 });
      const file = Bun.file(raw);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      // Resolve symlinks: the string-prefix check above can be defeated by a
      // symlink inside a tracked project that points outside it. Re-verify the
      // REAL path is still inside a tracked project before reading (R4 bt D5).
      let real: string;
      try { real = normalizeSlashes(await realpath(raw)); }
      catch { return new Response("Not found", { status: 404 }); }
      const realInside = Object.values(data.projects).some(p => {
        const pp = normalizeSlashes(p.path);
        return !!pp && (pathsEqual(real, pp) || isPathInside(pp, real));
      });
      if (!realInside) return new Response("Forbidden", { status: 403 });
      const MAX = 512 * 1024;
      let text = await file.text();
      if (text.length > MAX) text = `${text.slice(0, MAX)}\n\n… [${L("truncated — file larger than 512KB", "مقتطع — الملف أكبر من 512KB")}]`;
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
      });
    },

    "/releases/:project": async (req: ApiReq) => {
      // Bun already URL-decodes route params; decoding again throws URIError on
      // a name with a literal `%` (e.g. "100%done") → 500. Use the param as-is.
      const project = req.params.project;
      const data = await loadData();
      const p = data.projects[project];
      if (!p?.path) return new Response("Not found", { status: 404 });
      const file = Bun.file(join(p.path, ".devlog", "releases", "index.html"));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      // Redirect to the slashed form instead of serving here: the generated
      // pages link each other RELATIVELY (`v3.2.0.html`, `index.html` — they
      // must also work opened from disk), and a browser resolves those against
      // `/releases/` when the base lacks a trailing slash — turning a version
      // click into `/releases/v3.2.0.html`, which reads the FILENAME as a
      // project name → "Not found". Serving the index at
      // `/releases/:project/index.html` (the existing :version route) gives
      // every relative link the right base for free.
      const url = new URL(req.url);
      return new Response(null, { status: 301, headers: { Location: `${url.pathname}/index.html` } });
    },

    "/releases/:project/:version": async (req: ApiReq) => {
      const project = req.params.project;   // Bun pre-decodes; don't double-decode
      const version = req.params.version.replace(/[^\w.\-+]/g, "_");
      const data = await loadData();
      const p = data.projects[project];
      if (!p?.path) return new Response("Not found", { status: 404 });
      // Live NEXT-release preview (#490): rendered in memory through the same
      // pipeline as a real release — nothing written, nothing stored. Served
      // under the project's releases base so the page's relative links (crumb,
      // prev-version) resolve against the real baked pages.
      if (version === "preview.html" || version === "preview.json") {
        const { buildReleasePreview } = await import("./release-preview");
        const preview = await buildReleasePreview(data, project);
        if (!preview) return new Response("Not found", { status: 404 });
        if (version.endsWith(".json")) {
          const { html: _html, ...rest } = preview;
          return Response.json({ preview: true, ...rest });
        }
        return htmlResponse(preview.html);
      }
      const file = Bun.file(join(p.path, ".devlog", "releases", version));
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      // The machine-readable twin (vX.Y.Z.json) must not be served as HTML.
      if (version.endsWith(".json")) {
        return new Response(file, {
          headers: { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" },
        });
      }
      return htmlResponse(file);
    },
  };
}
