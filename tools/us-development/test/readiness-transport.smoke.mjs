import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

test(
  "US readiness GET crosses actual dev and preview proxies without widening the allowlist",
  { timeout: 30000 },
  async (t) => {
    const scripts = JSON.parse(readFileSync("apps/admin/package.json", "utf8")).scripts;
    const id = "a0000000-0000-4000-8000-000000000001";
    const path = "/api/us/traceability/readiness";
    const query = `?eventDateFrom=2026-09-01&eventDateTo=2026-09-28&productId=${id}&lotId=${id}`;
    const seen = [];
    const upstream = createServer((request, response) => {
      seen.push({ path: request.url, method: request.method, host: request.headers.host });
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ path: request.url }));
    });
    upstream.listen(3100, "localhost");
    await once(upstream, "listening");
    try {
      for (const scriptName of ["dev:us", "preview:us"]) {
        await t.test(scriptName, async () => {
          const command = scripts[scriptName].split(" ");
          const args =
            command[0] === "node"
              ? command.slice(1)
              : ["node_modules/vite/bin/vite.js", ...command.slice(1)];
          const env = { ...process.env, VITE_DEPLOYMENT_EDITION: "US" };
          delete env.NODE_OPTIONS;
          const child = spawn(process.execPath, args, {
            cwd: resolve("apps/admin"),
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const exited = once(child, "exit");
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr.on("data", (chunk) => {
            output += chunk;
          });
          try {
            let ready = false;
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
              assert.equal(child.exitCode, null, output);
              try {
                ready =
                  (await fetch("http://localhost:5174/", { signal: AbortSignal.timeout(250) }))
                    .status === 200;
                if (ready) break;
              } catch {
                /* Wait for the owned child. */
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.ok(ready, output);
            for (const suffix of ["", query]) {
              const response = await fetch("http://localhost:5174" + path + suffix);
              assert.equal(response.status, 200, scriptName);
              assert.equal(response.headers.get("cache-control"), "no-store");
              assert.deepEqual(await response.json(), { path: "/traceability/readiness" + suffix });
              assert.deepEqual(seen.at(-1), {
                path: "/traceability/readiness" + suffix,
                method: "GET",
                host: "localhost:3100",
              });
            }
            const before = seen.length;
            for (const [url, method] of [
              [path + query + "&tenantId=x", "GET"],
              [path + query + "&lotId=" + id, "GET"],
              [path + query + "&%6cotId=" + id, "GET"],
              [path + "/extra", "GET"],
              [path + "/", "GET"],
              [path.replace("/api/us/", "/api/"), "GET"],
              ...["POST", "PUT", "PATCH", "DELETE", "HEAD"].map((method) => [path + query, method]),
            ]) {
              const response = await fetch("http://localhost:5174" + url, { method });
              assert.equal(response.status, 404, `${scriptName} ${method} ${url}`);
              assert.equal(response.headers.get("cache-control"), "no-store");
            }
            // Vite's CORS layer precedes plugin hooks and handles preflight locally.
            const preflight = await fetch("http://localhost:5174" + path + query, {
              method: "OPTIONS",
            });
            assert.equal(preflight.status, 204);
            assert.equal(
              seen.length,
              before,
              "rejected paths and preflight must never reach the API",
            );
          } finally {
            if (child.exitCode === null) child.kill("SIGTERM");
            const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
            await exited;
            clearTimeout(timer);
          }
        });
      }
    } finally {
      await new Promise((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
