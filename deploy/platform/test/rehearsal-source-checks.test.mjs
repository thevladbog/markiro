import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, realpath, writeFile, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { createRehearsalSourceChecks, verifyRehearsalIsolation } from "../upgrade-ci.mjs";
import {
  forwardRehearsalDependencies,
  createForwardRehearsalProcess,
} from "../forward-ci-scenario.mjs";
import { rehearsalFixture } from "./rehearsal-fixture.mjs";
import { captureRehearsalResources } from "../upgrade-ci-guards.mjs";
async function setup(t, verifyIsolation = async () => {}) {
  const temporaryBase = await realpath(
    process.platform === "linux" ? "/home/runner/work/_temp" : "/tmp",
  );
  const root = await mkdtemp(join(temporaryBase, "markiro-upgrade-ci-source-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true }));
  await writeFile(join(root, "source.mjs"), "synthetic source\n", { mode: 0o600 });
  const closure = { "source.mjs": digest(Buffer.from("synthetic source\n")) };
  const values = { SMTP_HOST: "mail.invalid" };
  const checks = createRehearsalSourceChecks({
    root,
    closure,
    values,
    generated: Object.freeze({ ...values }),
    temporaryBase,
    verifyIsolation,
  });
  return { root, closure, values, checks };
}
test("source-only verifier rechecks every byte and generated environment without physical subprocesses", async (t) => {
  let physical = 0;
  const f = await setup(t, async () => physical++);
  await f.checks.verifySourceBytes();
  await writeFile(join(f.root, "source.mjs"), "changed\n");
  await assert.rejects(f.checks.verifySourceBytes());
  await writeFile(join(f.root, "source.mjs"), "synthetic source\n");
  await f.checks.verifySourceBytes();
  f.values.SMTP_HOST = "production.invalid";
  await assert.rejects(f.checks.verifySourceBytes());
  assert.equal(physical, 0);
});
test("ordinary return verifier preserves isolation before source/env verification on every call", async (t) => {
  let physical = 0;
  const f = await setup(t, async () => {
    physical++;
    if (physical === 2) await writeFile(join(f.root, "source.mjs"), "changed\n");
  });
  await f.checks.verifySources();
  await assert.rejects(f.checks.verifySources());
  assert.equal(physical, 2);
});
for (const fault of [null, "pre-route4", "post-route6"])
  test(`forward source checks retain all four fresh transport facts before/after command: ${fault}`, async (t) => {
    const f = await setup(t),
      physical = rehearsalFixture(),
      owned = captureRehearsalResources(physical);
    const reads = [];
    let children = 0;
    if (fault === "pre-route4") physical.routes.ipv4 = "default via synthetic";
    const verifyIsolation = () =>
      verifyRehearsalIsolation(
        physical.invocationId,
        {
          container: async () => {
            reads.push("container");
            return physical.container;
          },
          volume: async () => {
            reads.push("volume");
            return physical.volume;
          },
          ipv4: async () => {
            reads.push("ipv4");
            return physical.routes.ipv4;
          },
          ipv6: async () => {
            reads.push("ipv6");
            return physical.routes.ipv6;
          },
        },
        owned,
      );
    const counters = { sourceVerifications: 0 };
    const deps = forwardRehearsalDependencies(
      {
        deps: {
          verifySources: () => {
            throw Error("redundant physical checker");
          },
        },
        verifySourceBytes: f.checks.verifySourceBytes,
      },
      counters,
    );
    const process = createForwardRehearsalProcess({
      root: join(f.root, "state"),
      parent: f.root,
      repository: f.root,
      containerId: physical.container.Id,
      forwardStage: { sourceFiles: f.closure },
      verifyIsolation,
      stdinOuter: async () => {
        children++;
        if (fault === "post-route6") physical.routes.ipv6 = "default via synthetic";
        return { stdout: Buffer.from("ok"), stderr: Buffer.alloc(0) };
      },
    });
    const action = async () => {
      await deps.verifySources();
      const result = await process({
        executable: "/usr/bin/docker",
        args: ["--host", "unix:///var/run/docker.sock", "info"],
        env: { DOCKER_CONFIG: join(f.root, "state/docker") },
        timeoutMs: 1000,
        outputLimitBytes: 4096,
      });
      await deps.verifySources();
      return result;
    };
    if (fault) await assert.rejects(action());
    else assert.equal(String((await action()).stdout), "ok");
    assert.equal(children, fault === "pre-route4" ? 0 : 1);
    assert.equal(reads.length, fault === "pre-route4" ? 4 : 8);
    for (let i = 0; i < reads.length; i += 4)
      assert.deepEqual(reads.slice(i, i + 4), ["container", "volume", "ipv4", "ipv6"]);
    assert.equal(counters.sourceVerifications, fault ? 1 : 2);
  });

for (const fault of [null, "pre", "post"])
  test(`direct forward smoke/SQL/inspect transports retain physical guards: ${fault}`, async () => {
    const { guardRehearsalOperation } = await import("../upgrade-ci.mjs");
    let checks = 0,
      actions = 0;
    const guarded = guardRehearsalOperation(
      async () => {
        checks++;
        if ((fault === "pre" && checks === 1) || (fault === "post" && checks === 2))
          throw Error("synthetic isolation refusal");
      },
      async () => {
        actions++;
        return "ok";
      },
    );
    if (fault) await assert.rejects(guarded());
    else assert.equal(await guarded(), "ok");
    assert.equal(actions, fault === "pre" ? 0 : 1);
    assert.equal(checks, fault === "pre" ? 1 : 2);
  });
