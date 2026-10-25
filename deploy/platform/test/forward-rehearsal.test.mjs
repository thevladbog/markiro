import test from "node:test";
import assert from "node:assert/strict";
const load = () => import("../forward-ci.mjs");
test("forward rehearsal refuses alternate argv and caller-supplied production adapters", async () => {
  const { rehearseForwardRecovery } = await load();
  for (const args of [[], ["--production"], ["--local-ci", "--host", "201.34.136.19"]])
    await assert.rejects(rehearseForwardRecovery(args));
  await assert.rejects(
    rehearseForwardRecovery(["--local-ci"], {
      runProcess: () => {
        throw new Error("unsafe");
      },
    }),
  );
});
test("safe forward evidence rejects private output and incomplete acceptance claims", async () => {
  const { validateForwardRehearsalEvidence } = await load();
  const value = {
    version: 1,
    kind: "synthetic-only-forward-recovery-rehearsal",
    productionAdmission: false,
    invocationId: "11111111-1111-4111-8111-111111111111",
    productSha: "6e32b3bf5970ed8793293bcc7e80aef342836e53",
    completed: true,
    isolated: true,
    cleanup: true,
    checks: {
      migrationAppliedOnce: true,
      fullLedger: true,
      realBackupRestore: true,
      linuxHandoff: true,
      noOldStarts: true,
      noSecondMigrator: true,
      forwardHealthy: true,
      replacementFailureCleanup: true,
      externalTls: true,
    },
    problem: null,
  };
  assert.deepEqual(validateForwardRehearsalEvidence(value), value);
  for (const mutate of [
    (v) => (v.privateRoot = "/tmp/private"),
    (v) => (v.stdout = "secret"),
    (v) => (v.productionAdmission = true),
    (v) => (v.checks.realBackupRestore = false),
    (v) => (v.cleanup = false),
    (v) => (v.productSha = "a".repeat(40)),
  ]) {
    const bad = structuredClone(value);
    mutate(bad);
    assert.throws(() => validateForwardRehearsalEvidence(bad));
  }
});
import { rehearsalFixture } from "./rehearsal-fixture.mjs";
import { createForwardRehearsalProcess } from "../forward-ci-scenario.mjs";
import { validateRehearsalDaemon, captureRehearsalResources } from "../upgrade-ci-guards.mjs";
for (const fault of [
  "route4",
  "route6",
  "host socket",
  "foreign volume",
  "foreign cleanup ID",
  "external network",
])
  test(`forward process refuses ${fault} through actual isolation guard before command`, async () => {
    const f = rehearsalFixture(),
      owned = captureRehearsalResources(f);
    if (fault === "route4") f.routes.ipv4 = "default via 172.17.0.1";
    if (fault === "route6") f.routes.ipv6 = "default via fe80::1";
    if (fault === "host socket")
      f.container.Mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/var/run/docker.sock",
        RW: true,
      });
    if (fault === "foreign volume") f.container.Mounts[0].Name = "foreign";
    if (fault === "foreign cleanup ID") f.container.Id = "b".repeat(64);
    if (fault === "external network")
      f.container.NetworkSettings.Networks.bridge = { NetworkID: "b".repeat(64) };
    let commands = 0;
    const run = createForwardRehearsalProcess({
      root: "/tmp/generated/state",
      verifyIsolation: async () => validateRehearsalDaemon(f, owned),
      shell: async () => {
        commands++;
      },
    });
    await assert.rejects(
      run({
        executable: "/usr/bin/docker",
        args: ["--host", "unix:///var/run/docker.sock", "info"],
        env: { DOCKER_CONFIG: "/tmp/generated/state/docker" },
      }),
    );
    assert.equal(commands, 0);
  });
for (const args of [
  ["create", "--privileged"],
  ["create", "--network", "host"],
  ["create", "--mount", "type=bind,source=/var/run/docker.sock,target=/socket"],
  ["create", "--mount", "type=bind,source=/opt/production/env,target=/input"],
  ["create", "--mount", "type=bind,source=/tmp/generated/state/../outside,target=/input"],
])
  test(`forward rehearsal refuses unsafe workload ${args[1]} before any command`, async () => {
    let commands = 0;
    const run = createForwardRehearsalProcess({
      root: "/tmp/generated/state",
      parent: "/tmp/generated",
      verifyIsolation: async () => {},
      shell: async () => {
        commands++;
      },
    });
    await assert.rejects(
      run({
        executable: "/usr/bin/docker",
        args: ["--host", "unix:///var/run/docker.sock", ...args],
        env: { DOCKER_CONFIG: "/tmp/generated/state/docker" },
      }),
    );
    assert.equal(commands, 0);
  });
import { createForwardScenario, forwardProduct } from "../forward-ci-scenario.mjs";
import { hostIdentity, hostEnv } from "./host-fixtures.mjs";
import { validateIdentity } from "../host/state-validation.mjs";
import { validateConfig } from "../preflight.mjs";
test("fixed forward product and runtime agree on both product SHAs and exact image identities", async () => {
  const candidate = hostIdentity(),
    scenario = createForwardScenario("healthy");
  await scenario.candidate(candidate);
  validateIdentity(candidate);
  const env = {
    ...hostEnv(candidate.admission.manifest, "/tmp/generated/state"),
    ...scenario.values(),
  };
  validateConfig(env, candidate.admission.manifest);
  assert.equal(env.MARKIRO_SOURCE_SHA, forwardProduct);
  assert.equal(env.MARKIRO_TOOLING_SHA, forwardProduct);
  assert.notEqual(candidate.executorSha, forwardProduct);
});
