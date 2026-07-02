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
import dashboardCss from "../assets/dashboard.css" with { type: "text" };
import dashboardJs from "../assets/dashboard.js" with { type: "text" };
// Binary asset: the "file" loader yields a path (real on disk in dev, virtual
// in the compiled fs) that Bun.file() can stream either way.
import dashboardJpeg from "../assets/dashboard.jpeg" with { type: "file" };

export const STATIC_HTML: Record<string, string> = {
  "dashboard.html": dashboardHtmlBundle as unknown as string,
  "stack-map.html": stackMapHtmlBundle as unknown as string,
  "features.html": featuresHtmlBundle as unknown as string,
};

type Asset = { text: string; mime: string } | { file: string; mime: string };

export const STATIC_ASSETS: Record<string, Asset> = {
  "dashboard.css": { text: dashboardCss, mime: "text/css; charset=utf-8" },
  "dashboard.js": { text: dashboardJs, mime: "application/javascript; charset=utf-8" },
  "dashboard.jpeg": { file: dashboardJpeg, mime: "image/jpeg" },
};
