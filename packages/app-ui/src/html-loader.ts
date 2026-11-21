import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_BUILT_HTML_PATH = resolve(import.meta.dirname, "../dist-web/triage-app.html");

const FALLBACK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="color-scheme" content="light dark" />
  <title>Bugzilla Triage Workbench</title>
</head>
<body>
  <main style="font-family:system-ui,sans-serif;padding:16px">
    <h1>Bugzilla Triage Workbench</h1>
    <p>Run <code>bun run build:ui</code> to build the single-file MCP App UI bundle.</p>
  </main>
</body>
</html>`;

/**
 * Loads the built single-file MCP App HTML document (SEP-1865).
 * Supports BUGZILLA_APP_HTML env var override for live UI iteration.
 */
export function loadTriageAppHtml(overridePath?: string): string {
  const candidate = overridePath ?? process.env.BUGZILLA_APP_HTML ?? DEFAULT_BUILT_HTML_PATH;
  if (existsSync(candidate)) {
    return readFileSync(candidate, "utf8");
  }
  return FALLBACK_HTML;
}
