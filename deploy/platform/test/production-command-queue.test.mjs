// Split from production-command.test.mjs so it runs on its own worker.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runHostCommand } from "../host/command.mjs";
import { integrationOptions } from "./host-command-integration-fixture.mjs";
import { calls, fixture } from "./production-command-fixture.mjs";
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
