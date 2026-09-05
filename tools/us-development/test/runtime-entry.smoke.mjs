import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { parseEnv } from "node:util";
import test from "node:test";

const example = () => parseEnv(readFileSync("deploy/us-development/local.env.example", "utf8"));

test("compiled RU executable rejects US before opening database or HTTP connections", () => {
  const result = spawnSync(process.execPath, ["apps/api/dist/main.js"], {
    env: { NODE_ENV: "development", MARKIRO_DEPLOYMENT_EDITION: "US" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use the explicit US API entry point/);
});

test("compiled US executable refuses production and missing edition configuration", () => {
  for (const env of [
    { ...example(), NODE_ENV: "production" },
    { ...example(), MARKIRO_DEPLOYMENT_EDITION: "" },
  ]) {
    const result = spawnSync(process.execPath, ["apps/api/dist/main.us.js"], {
      env,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /US development API startup refused/);
  }
});

test("compiled US API keeps readiness closed and shuts down its local composition cleanly", async () => {
  const child = spawn(process.execPath, ["apps/api/dist/main.us.js"], {
    env: example(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const deadline = Date.now() + 6000;
    let deployment;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, stderr);
      try {
        deployment = await fetch("http://127.0.0.1:3100/deployment", {
          signal: AbortSignal.timeout(250),
        });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    assert.ok(deployment, "US listener did not start");
    assert.deepEqual(await deployment.json(), {
      edition: "US",
      releaseEnabled: false,
      interfaceLocales: ["en-US", "es-US"],
      defaultInterfaceLocale: "en-US",
    });
    assert.equal((await fetch("http://127.0.0.1:3100/health/ready")).status, 503);
    assert.equal((await fetch("http://127.0.0.1:3100/1c_exchange")).status, 404);
    assert.equal((await fetch("http://127.0.0.1:3100/api/auth/get-session")).status, 404);
    assert.equal((await fetch("http://localhost:3100/traceability/profile")).status, 401);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3000);
    const [code, signal] = await closed;
    clearTimeout(timeout);
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
  }
});
