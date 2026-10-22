import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import test from "node:test";

const example = () => parseEnv(readFileSync("deploy/us-development/local.env.example", "utf8"));
const tenant = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const verify = ["verify", "--tenant-id", tenant, "--owner-id", owner];
const provision = ["provision", ...verify.slice(1), "--confirm-local-synthetic-viewer"];
const marker = "Synthetic-stdin-secret-not-for-output-42!";

test("actual compiled viewer refuses unsafe arguments, env and stdin without connection or disclosure", () => {
  for (const [args, override, input] of [
    [[], {}, marker],
    [provision.slice(0, -1), {}, marker],
    [[...provision, "--reset"], {}, marker],
    [[...provision, "--force"], {}, marker],
    [[...provision, "--password", marker], {}, marker],
    [[...provision, "--role", "owner"], {}, marker],
    [["verify", "--owner-id", owner, "--tenant-id", tenant], {}, marker],
    [provision, { NODE_ENV: "production" }, marker],
    [verify, { MARKIRO_DEPLOYMENT_EDITION: "RU" }, marker],
    [provision, { VITE_DEPLOYMENT_EDITION: "RU" }, marker],
    ...[
      "postgres://bad:secret@remote.example:55432/markiro_us_dev",
      "postgres://other:secret@127.0.0.1:55432/markiro_us_dev",
      "postgres://markiro_us:secret@127.0.0.1:5432/markiro_us_dev",
      "postgres://markiro_us:secret@127.0.0.1:55432/markiro",
    ].map((DATABASE_URL) => [provision, { DATABASE_URL }, marker]),
    ...[
      "",
      "short",
      "x".repeat(129),
      `${marker}\ninside`,
      `${marker}\rinside`,
      `${marker}\0`,
      "x".repeat(513),
    ].map((input) => [provision, {}, input]),
    [verify, {}, "short"],
  ]) {
    const result = spawnSync(process.execPath, ["apps/api/dist/main.us-viewer.js", ...args], {
      env: { ...example(), ...override },
      input,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^US synthetic viewer command refused\./);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(marker));
    assert.ok(!result.stderr.includes("postgres://"));
    assert.ok(!result.stderr.includes("secret@"));
  }
});
