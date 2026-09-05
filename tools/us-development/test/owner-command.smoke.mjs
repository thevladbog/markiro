import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import test from "node:test";

const example = () => parseEnv(readFileSync("deploy/us-development/local.env.example", "utf8"));

test("compiled owner provisioner rejects unsafe targets/arguments without disclosing input", () => {
  const marker = "Synthetic-stdin-secret-not-for-output-42!";
  for (const [args, override] of [
    [[], {}],
    [["--confirm-local-synthetic-owner", "--reset"], {}],
    [["--confirm-local-synthetic-owner"], { NODE_ENV: "production" }],
    [["--confirm-local-synthetic-owner"], { MARKIRO_DEPLOYMENT_EDITION: "RU" }],
    [
      ["--confirm-local-synthetic-owner"],
      { DATABASE_URL: "postgres://bad:secret@remote.example:55432/markiro_us_dev" },
    ],
  ]) {
    const result = spawnSync(process.execPath, ["apps/api/dist/main.us-provision.js", ...args], {
      env: { ...example(), ...override },
      input: marker,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /US synthetic owner provisioning refused/);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(marker));
    assert.ok(!result.stderr.includes("postgres://"));
  }
});
