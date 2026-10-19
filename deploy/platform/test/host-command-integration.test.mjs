import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runHostCommand } from "../host/command.mjs";
import {
  commandIntegrationFixture,
  integrationOptions,
} from "./host-command-integration-fixture.mjs";

const state = async (root) => JSON.parse(await readFile(join(root, "state.json"), "utf8"));
const trace = async (root) =>
  String(await readFile(join(root, "daemon.json.trace")))
    .trim()
    .split("\n")
    .map(JSON.parse);

test("public command integrates admission refresh, factual process observers, owned probe cleanup and durable healthy completion", async (t) => {
  const f = await commandIntegrationFixture(t);
  assert.deepEqual(await runHostCommand([f.root], await integrationOptions(f.root)), f.identity);
  const journal = await state(f.root);
  assert.equal(journal.current.phase, "healthy");
  assert.equal(journal.current.status, "completed");
  assert.equal(journal.sequence, 18);
  const calls = await trace(f.root);
  const compose = calls.filter((c) => c.args[0] === "compose");
  assert.deepEqual(
    compose.map((c) => c.args.slice(7)),
    [
      ["pull", "api", "edge", "postgres"],
      ["stop", "edge", "api"],
      ["up", "-d", "--wait", "--no-deps", "postgres"],
      [
        "run",
        "--rm",
        "--no-deps",
        "--name",
        `markiro-platform-migrate-${f.identity.operationId}`,
        "--label",
        `io.markiro.operation=${f.identity.operationId}`,
        "migrate",
      ],
      ["up", "-d", "--wait", "--no-deps", "api"],
      ["up", "-d", "--no-deps", "edge"],
    ],
  );
  assert.ok(calls.some((c) => c.args[0] === "exec"));
  assert.ok(calls.some((c) => c.args[0] === "create"));
  const daemon = JSON.parse(await readFile(join(f.root, "daemon.json"), "utf8"));
  assert.equal(
    daemon.containers.filter((c) => c.Config.Labels["io.markiro.probe-operation"]).length,
    0,
  );
  const external = JSON.parse(await readFile(join(f.root, "external-calls.json"), "utf8"));
  assert.ok(external.github.some((url) => url.includes("/artifacts/789/zip")));
  assert.ok(external.github.filter((url) => url.endsWith("/runs/456")).length >= 3);
  assert.ok(external.github.some((url) => url.includes("/runs/124/attempts/1/jobs")));
  assert.equal(external.smoke.length, 6);
});

for (const failureMode of ["migration-failure", "uncertain-migration"])
  test(`CLI process preserves sanitized failure flags and durable recovery for ${failureMode}`, async (t) => {
    const f = await commandIntegrationFixture(t, failureMode);
    let result;
    try {
      await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("./fixtures/host-command-cli.mjs", import.meta.url)), f.root],
        { cwd: f.root, env: { PATH: "/usr/bin:/bin" }, timeout: 120000, maxBuffer: 65536 },
      );
      assert.fail("must fail");
    } catch (error) {
      result = error;
    }
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    const failure = JSON.parse(result.stderr);
    assert.deepEqual(failure, {
      version: 1,
      kind: "platform-host-command-failure",
      code: "ERR_HOST_COMMAND",
      terminationConfirmed: failureMode === "uncertain-migration" ? false : null,
      recoveryRequired: true,
      durabilityUncertain: failureMode === "uncertain-migration",
    });
    const journal = await state(f.root);
    assert.equal(journal.current.phase, "migrating");
    assert.equal(journal.current.status, "recovery-required");
    const calls = await trace(f.root);
    const migration = calls.findIndex((c) => c.args[0] === "compose" && c.args[7] === "run");
    assert.ok(migration > 0);
    assert.ok(
      !calls.slice(migration + 1).some((c) => c.args[0] === "compose" && c.args[7] === "up"),
    );
    if (failureMode === "uncertain-migration") assert.equal(calls.length, migration + 1);
  });
