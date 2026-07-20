// Dashboard static assets, embedded into the compiled binary via Bun's import
// attributes. The same imports work under `bun src/server.ts` (Bun reads from
// disk at runtime) and inside a `--compile` executable (Bun bakes the bytes in),
// so the serving path in server.ts is uniform across both modes. This is what
// makes the single-file executable actually standalone — no sibling
// dashboard.html / assets/ directory required next to the .exe.
// .html imports are typed as HTMLBundle by bun-types; with { type: "text" }
// Bun returns the raw markup as a string at runtime, so cast through unknown.
import dashboardHtmlBundle from "../dashboard.html" with { type: "text" };
import stackMapHtmlBundle from "../stack-map.html" with { type: "text" };
import featuresHtmlBundle from "../features.html" with { type: "text" };
import depsHtmlBundle from "../deps.html" with { type: "text" };
import dashboardCss from "../assets/dashboard.css" with { type: "text" };
// dashboard.js was split into topical files (report #9); R3 #3 made them ES
// modules — dashboard-main.js is the entry, dashboard-state.js holds the
// shared mutable state, and every cross-file reference is an explicit import.
import dashboardMainJs from "../assets/dashboard-main.js" with { type: "text" };
import dashboardStateJs from "../assets/dashboard-state.js" with { type: "text" };
import dashboardCoreJs from "../assets/dashboard-core.js" with { type: "text" };
import dashboardDataJs from "../assets/dashboard-data.js" with { type: "text" };
import dashboardProjectJs from "../assets/dashboard-project.js" with { type: "text" };
import dashboardPanelsJs from "../assets/dashboard-panels.js" with { type: "text" };
import dashboardTreeWsJs from "../assets/dashboard-tree-ws.js" with { type: "text" };
import dashboardDocsCardJs from "../assets/dashboard-docs-card.js" with { type: "text" };
import stackMapJs from "../assets/stack-map.js" with { type: "text" };
import depsJs from "../assets/deps.js" with { type: "text" };
// Binary asset: the "file" loader yields a path (real on disk in dev, virtual
// in the compiled fs) that Bun.file() can stream either way.
import dashboardJpeg from "../assets/dashboard.jpeg" with { type: "file" };

export const STATIC_HTML: Record<string, string> = {
  "dashboard.html": dashboardHtmlBundle as unknown as string,
  "stack-map.html": stackMapHtmlBundle as unknown as string,
  "features.html": featuresHtmlBundle as unknown as string,
  "deps.html": depsHtmlBundle as unknown as string,
};

type Asset = { text: string; mime: string } | { file: string; mime: string };

export const STATIC_ASSETS: Record<string, Asset> = {
  "dashboard.css": { text: dashboardCss, mime: "text/css; charset=utf-8" },
  "dashboard-main.js": { text: dashboardMainJs, mime: "application/javascript; charset=utf-8" },
  "dashboard-state.js": { text: dashboardStateJs, mime: "application/javascript; charset=utf-8" },
  "dashboard-core.js": { text: dashboardCoreJs, mime: "application/javascript; charset=utf-8" },
  "dashboard-data.js": { text: dashboardDataJs, mime: "application/javascript; charset=utf-8" },
  "dashboard-project.js": { text: dashboardProjectJs, mime: "application/javascript; charset=utf-8" },
  "dashboard-panels.js": { text: dashboardPanelsJs, mime: "application/javascript; charset=utf-8" },
  "dashboard-tree-ws.js": { text: dashboardTreeWsJs, mime: "application/javascript; charset=utf-8" },
  "dashboard-docs-card.js": { text: dashboardDocsCardJs, mime: "application/javascript; charset=utf-8" },
  "stack-map.js": { text: stackMapJs, mime: "application/javascript; charset=utf-8" },
  "deps.js": { text: depsJs, mime: "application/javascript; charset=utf-8" },
  "dashboard.jpeg": { file: dashboardJpeg, mime: "image/jpeg" },
};
