import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Express, Request, Response } from "express";

const scalarBundlePath = join(
  dirname(require.resolve("@scalar/api-reference")),
  "browser",
  "standalone.js",
);
const scalarDynamicCodeProbe = "try{return Function(``),!0}catch{return!1}";

export function disableScalarDynamicCodeProbe(bundle: string): string {
  // Zod's runtime feature probe emits a CSP violation even though it catches the blocked call.
  // Scalar's standalone bundle does not expose the shared Zod instance needed to set `jitless`.
  // Keep this exact-version transform fail-closed until https://github.com/colinhacks/zod/issues/4461
  // is resolved upstream or Scalar exposes a CSP-safe browser bundle.
  const parts = bundle.split(scalarDynamicCodeProbe);
  if (parts.length !== 2)
    throw new Error("Scalar browser bundle must contain exactly one known dynamic-code probe");
  return `${parts[0]}return!1${parts[1]}`;
}

const scalarBundle = disableScalarDynamicCodeProbe(readFileSync(scalarBundlePath, "utf8"));

const docsHtml = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Markiro API</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="/docs/scalar.js"></script>
    <script src="/docs/bootstrap.js"></script>
  </body>
</html>`;

const bootstrapScript = `Scalar.createApiReference("#app", {
  url: "/openapi.json",
  telemetry: false,
  withDefaultFonts: false,
  hideClientButton: true,
  hideTestRequestButton: true,
  showDeveloperTools: "never",
  agent: { disabled: true },
  mcp: { disabled: true }
});\n`;

function sendHtml(_request: Request, response: Response): void {
  response.type("html").set("Cache-Control", "no-cache").send(docsHtml);
}

export function mountOpenApiDocs(server: Express): void {
  server.get(["/docs", "/docs/"], sendHtml);
  server.get("/docs/scalar.js", (_request, response) => {
    response.type("application/javascript").set("Cache-Control", "no-cache").send(scalarBundle);
  });
  server.get("/docs/bootstrap.js", (_request, response) => {
    response.type("application/javascript").set("Cache-Control", "no-cache").send(bootstrapScript);
  });
}
