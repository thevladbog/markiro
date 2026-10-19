import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runHostCommand } from "../host/command.mjs";
import { productionAuthorization } from "./production-activation-fixture.mjs";
import {
  commandIntegrationFixture,
  integrationOptions,
} from "./host-command-integration-fixture.mjs";
async function fixture(t) {
  const f = await commandIntegrationFixture(t),
    record = f.record.deployment.preparedTarget;
  record.version = 2;
  record.observations.egress.observedAt = new Date().toISOString();
  record.observations.egress.value = productionAuthorization(record, f);
  await f.publish();
  const path = join(f.root, "daemon.json"),
    daemon = JSON.parse(await readFile(path));
  daemon.activationProjection = structuredClone(record.observations.egress.value.review.projection);
  await writeFile(path, JSON.stringify(daemon), { mode: 0o600 });
  return f;
}
async function calls(f) {
  return String(await readFile(join(f.root, "daemon.json.trace")))
    .trim()
    .split("\n")
    .map(JSON.parse);
}
test("changed retained intent prevents first API and edge commands and preserves failure journal", async (t) => {
  const f = await fixture(t),
    path = join(f.root, "daemon.json"),
    daemon = JSON.parse(await readFile(path));
  daemon.activationProjection[0] = {
    ...daemon.activationProjection[0],
    rows: 1,
    pending: 1,
    sha256: "a".repeat(64),
  };
  await writeFile(path, JSON.stringify(daemon));
  await assert.rejects(runHostCommand([f.root], await integrationOptions(f.root)));
  const trace = await calls(f);
  assert.ok(
    !trace.some(
      (c) =>
        c.args[0] === "compose" && c.args[7] === "up" && ["api", "edge"].includes(c.args.at(-1)),
    ),
  );
  assert.equal(
    JSON.parse(await readFile(join(f.root, "state.json"))).current.status,
    "recovery-required",
  );
});
test("first production activation permits normal queue mutations after API starts", async (t) => {
  const f = await fixture(t),
    options = await integrationOptions(f.root),
    run = options.runProcess;
  options.runProcess = async (req) => {
    const result = await run(req);
    if (req.args[2] === "compose" && req.args.at(-1) === "api" && req.args[9] === "up") {
      const path = join(f.root, "daemon.json"),
        d = JSON.parse(await readFile(path));
      d.activationProjection[0] = {
        ...d.activationProjection[0],
        rows: 1,
        pending: 1,
        sha256: "a".repeat(64),
      };
      await writeFile(path, JSON.stringify(d));
    }
    return result;
  };
  await runHostCommand([f.root], options);
  const trace = await calls(f);
  assert.equal(trace.filter((c) => c.args[0] === "exec" && c.args.includes("--file")).length, 2);
  assert.ok(trace.some((c) => c.args[0] === "compose" && c.args.at(-1) === "api"));
  assert.equal(JSON.parse(await readFile(join(f.root, "state.json"))).current.phase, "healthy");
});
test("authorization expiring during final asynchronous target query never issues API command", async (t) => {
  const f = await fixture(t),
    options = await integrationOptions(f.root),
    run = options.runProcess;
  const actualNow = Date.now.bind(Date);
  let now;
  t.mock.method(Date, "now", () => now ?? actualNow());
  let queries = 0;
  options.runProcess = async (req) => {
    const result = await run(req);
    if (req.args[2] === "exec" && req.args.includes("--file") && ++queries === 2)
      now = Date.parse(f.record.deployment.preparedTarget.observations.egress.value.expiresAt) + 1;
    return result;
  };
  await assert.rejects(runHostCommand([f.root], options));
  assert.equal(queries, 2);
  assert.ok(
    !(await calls(f)).some(
      (c) =>
        c.args[0] === "compose" && c.args[7] === "up" && ["api", "edge"].includes(c.args.at(-1)),
    ),
  );
});
