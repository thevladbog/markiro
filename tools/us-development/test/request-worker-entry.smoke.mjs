import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";

const example = () => parseEnv(readFileSync("deploy/us-development/local.env.example", "utf8"));
const packageStorage = {
  US_REQUEST_PACKAGE_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_REQUEST_PACKAGE_S3_REGION: "us-east-1",
  US_REQUEST_PACKAGE_S3_BUCKET: "synthetic-worker-smoke",
  US_REQUEST_PACKAGE_S3_ACCESS_KEY_ID: "synthetic-worker-access",
  US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY: "synthetic-worker-secret",
  US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE: "true",
};

test("compiled worker refuses unsafe configuration, arguments and dirty/malformed build without a listener", () => {
  const temporary = mkdtempSync(join(tmpdir(), "us-worker-entry-"));
  const guard = join(temporary, "guard.cjs");
  const opened = join(temporary, "listener-opened");
  const descriptor = "apps/api/dist/us-request-build.json";
  const saved = existsSync(descriptor) ? readFileSync(descriptor) : null;
  assert.ok(saved, "Build the worker and its descriptor before running the compiled smoke");
  const document = JSON.parse(saved.toString("utf8"));
  writeFileSync(
    guard,
    `require('node:net').Server.prototype.listen = function () { require('node:fs').writeFileSync(${JSON.stringify(opened)}, 'opened'); throw new Error('forbidden listener'); };`,
  );
  try {
    const cases = [
      { env: { ...example(), NODE_ENV: "production" }, code: 1 },
      { env: { ...example(), MARKIRO_DEPLOYMENT_EDITION: "RU" }, code: 1 },
      { env: { ...example(), MARKIRO_DEPLOYMENT_EDITION: "" }, code: 1 },
      { env: example(), code: 2 },
      {
        env: { ...example(), US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY: "raw-configured-secret" },
        code: 1,
      },
      {
        env: { ...example(), ...packageStorage },
        args: ["--unexpected=raw-configured-secret"],
        code: 1,
      },
      { env: { ...example(), ...packageStorage }, manifest: "{malformed-secret", code: 1 },
      {
        env: { ...example(), ...packageStorage },
        manifest: JSON.stringify({ ...document, build: { ...document.build, dirty: true } }),
        code: 1,
      },
    ];
    for (const scenario of cases) {
      if (scenario.manifest) writeFileSync(descriptor, scenario.manifest);
      const result = spawnSync(
        process.execPath,
        ["--require", guard, "apps/api/dist/main.us-request-worker.js", ...(scenario.args ?? [])],
        { env: scenario.env, encoding: "utf8", timeout: 6000 },
      );
      assert.equal(result.status, scenario.code, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^us_request_worker_(startup_refused|storage_unavailable)\n$/);
      for (const value of [
        ...Object.values(scenario.env),
        "raw-configured-secret",
        "malformed-secret",
      ]) {
        if (value.length > 8) assert.ok(!result.stderr.includes(value));
      }
      assert.equal(existsSync(opened), false);
    }
  } finally {
    if (saved) writeFileSync(descriptor, saved);
    else if (existsSync(descriptor)) rmSync(descriptor);
    rmSync(temporary, { recursive: true, force: true });
  }
});
