import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Express, Request, Response } from "express";

const scalarBundlePath = join(
  dirname(require.resolve("@scalar/api-reference")),
  "browser",
  "standalone.js",
);
const scalarBundle = readFileSync(scalarBundlePath, "utf8");

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
  showDeveloperTools: "never"
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
