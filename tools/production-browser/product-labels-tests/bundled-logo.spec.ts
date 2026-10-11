import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const station = fileURLToPath(new URL("../../../apps/station", import.meta.url));
let directory: string;
let server: Server;
let origin: string;

test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "markiro-bundled-logo-"));
  execFileSync(
    process.execPath,
    [
      join(station, "node_modules/vite/bin/vite.js"),
      "build",
      "--config",
      join(station, "test/browser/bundled-logo-vite.config.mjs"),
      "--outDir",
      directory,
    ],
    { cwd: station, stdio: "pipe" },
  );
  const config = JSON.parse(readFileSync(join(station, "src-tauri/tauri.conf.json"), "utf8")) as {
    app: { security: { csp: string } };
  };
  server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const path = resolve(directory, `.${pathname}`);
    if (!path.startsWith(directory + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      response.setHeader("Content-Security-Policy", config.app.security.csp);
      response.setHeader(
        "Content-Type",
        extname(path) === ".js"
          ? "text/javascript"
          : extname(path) === ".svg"
            ? "image/svg+xml"
            : "text/html",
      );
      response.end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
      origin = `http://127.0.0.1:${address.port}`;
      done();
    });
  });
});

test.afterAll(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("production bundled logo decodes under the installed Station CSP", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("Content Security Policy"))
      violations.push(message.text());
  });
  await page.goto(`${origin}/test/browser/bundled-logo.html`);
  await expect(page.locator("#result")).toHaveText(
    JSON.stringify({ width: 980, height: 224, hasInk: true }),
  );
  expect(violations).toEqual([]);
});
