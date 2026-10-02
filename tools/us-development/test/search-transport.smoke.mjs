import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

test(
  "US dev and preview transport encoded 8 KiB TLC lists through the strict proxy",
  { timeout: 30000 },
  async (t) => {
    const scripts = JSON.parse(readFileSync("apps/admin/package.json", "utf8")).scripts;
    const list = Array.from({ length: 44 }, (_, index) => "界".repeat(60) + index);
    list[43] += "界".repeat(20) + "A";
    const raw = JSON.stringify(list);
    assert.equal(Buffer.byteLength(raw), 8192);
    const query = new URLSearchParams({
      tlcList: raw,
      q: "界".repeat(200),
      productText: "界".repeat(200),
      tlc: "𐐀".repeat(120),
      tlcFrom: "𐐀".repeat(120),
      tlcTo: "𐐀".repeat(120),
      documentType: "界".repeat(2000),
      documentNumber: "界".repeat(128),
      sourceReferenceValue: "https://example.test/" + "界".repeat(334) + "A",
    });
    const path = "/api/us/traceability/search?" + query.toString();
    assert.ok(Buffer.byteLength(path) > 50 * 1024);
    const seen = [];
    const upstream = createServer({ maxHeaderSize: 65536 }, (request, response) => {
      seen.push(request.url);
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ path: request.url }));
    });
    upstream.listen(3100, "localhost");
    await once(upstream, "listening");
    try {
      for (const scriptName of ["dev:us", "preview:us"]) {
        await t.test(scriptName, async () => {
          const command = scripts[scriptName].split(" ");
          // Execute the actual package command without a shell or inherited global Node flags.
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
                const response = await fetch("http://localhost:5174/", {
                  signal: AbortSignal.timeout(250),
                });
                ready = response.status === 200;
                if (ready) break;
              } catch {
                /* Wait only for this owned child to start. */
              }
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.ok(ready, output);
            const response = await fetch("http://localhost:5174" + path, {
              headers: { Cookie: "size_probe=" + "x".repeat(4096) },
            });
            assert.equal(response.status, 200, scriptName);
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.deepEqual(await response.json(), { path: path.replace("/api/us", "") });
            const before = seen.length;
            for (const [suffix, method] of [
              ["&tenantId=x", "GET"],
              ["&tlcList=%5B%22A%22%5D", "GET"],
              ["", "POST"],
              ["&cursor=" + "x".repeat(513), "GET"],
            ]) {
              const rejected = await fetch("http://localhost:5174" + path + suffix, { method });
              assert.equal(rejected.status, 404, scriptName + suffix);
              assert.equal(rejected.headers.get("cache-control"), "no-store");
            }
            assert.equal(seen.length, before);
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
