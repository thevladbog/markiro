import assert from "node:assert/strict";
import test from "node:test";

import { deployRelease } from "../remote-deploy.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ID = "987654321";
const API = `ghcr.io/thevladbog/markiro-api@sha256:${"a".repeat(64)}`;
const EDGE = `ghcr.io/thevladbog/markiro-edge@sha256:${"b".repeat(64)}`;
const PREVIOUS_API = `ghcr.io/thevladbog/markiro-api@sha256:${"c".repeat(64)}`;
const PREVIOUS_EDGE = `ghcr.io/thevladbog/markiro-edge@sha256:${"d".repeat(64)}`;

const MANIFEST = JSON.stringify({
  api: API,
  commit: COMMIT,
  createdAt: "2026-08-05T10:00:00.000Z",
  edge: EDGE,
  workflowRunId: RUN_ID,
});

function fixture({ failAt } = {}) {
  const events = [];
  const calls = [];
  const phase = async (name, payload) => {
    events.push(name);
    calls.push({ name, payload });
    if (failAt === name) throw new Error(`${name} failed`);
  };
  const dependencies = {
    expectedWorkflowRunId: RUN_ID,
    expectedCommit: COMMIT,
    onPhase: (name) => events.push(name),
    verifyInfrastructure: (payload) => phase("verify infrastructure", payload),
    verifyBackup: (payload) => phase("verify backup", payload),
    async withRunner(callback) {
      events.push("start runner");
      try {
        return await callback({ id: 71 });
      } finally {
        events.push("cleanup runner");
      }
    },
    readPreviousRelease: async () => ({ api: PREVIOUS_API, edge: PREVIOUS_EDGE }),
    transferBundle: (payload) => phase("transfer immutable bundle", payload),
    refreshRuntime: (payload) => phase("runtime refresh", payload),
    preflight: (payload) => phase("preflight", payload),
    pullDigests: (payload) => phase("pull digests", payload),
    migrate: (payload) => phase("migrate", payload),
    startApi: (payload) => phase("API ready", payload),
    startEdge: (payload) => phase("edge ready", payload),
    verifyAlb: (payload) => phase("ALB healthy", payload),
    smoke: (payload) => phase("external smoke", payload),
    rollback: (payload) => phase("rollback", payload),
    writeRelease: (payload) => phase(`${payload.state} record`, payload),
  };
  return { dependencies, events, calls };
}

test("deployRelease validates trusted identity before gates and performs the exact private order", async () => {
  const { dependencies, events, calls } = fixture();

  const record = await deployRelease(dependencies, MANIFEST);

  assert.deepEqual(events, [
    "validate manifest",
    "verify infrastructure",
    "verify backup",
    "start runner",
    "transfer immutable bundle",
    "runtime refresh",
    "preflight",
    "pull digests",
    "migrate",
    "API ready",
    "edge ready",
    "ALB healthy",
    "external smoke",
    "healthy record",
    "cleanup runner",
  ]);
  assert.deepEqual(record, {
    api: API,
    commit: COMMIT,
    edge: EDGE,
    releaseWorkflowRunId: RUN_ID,
    state: "healthy",
  });
  const transfer = calls.find((call) => call.name === "transfer immutable bundle").payload;
  assert.deepEqual(transfer, {
    destination: `/opt/markiro/releases/${COMMIT}`,
    sources: ["compose.production.yml", "deploy/production", "release-manifest.json"],
    transport: { internalAddress: true, kind: "yandex-os-login", staticKey: false },
  });
  const preflight = calls.find((call) => call.name === "preflight").payload;
  assert.deepEqual(preflight.images, { api: API, edge: EDGE });
});

test("deployRelease rejects a tag-shaped or mismatched release manifest before cloud checks", async () => {
  const { dependencies, events } = fixture();
  const tagManifest = MANIFEST.replace(API, "ghcr.io/thevladbog/markiro-api:main");

  await assert.rejects(deployRelease(dependencies, tagManifest), /invalid release manifest/);
  await assert.rejects(
    deployRelease({ ...dependencies, expectedWorkflowRunId: "123" }, MANIFEST),
    /invalid release manifest/,
  );

  assert.deepEqual(events, ["validate manifest", "validate manifest"]);
});

test("migration failure switches neither service and performs no image rollback", async () => {
  const { dependencies, events } = fixture({ failAt: "migrate" });

  await assert.rejects(deployRelease(dependencies, MANIFEST), /migrate failed/);

  assert.equal(events.includes("API ready"), false);
  assert.equal(events.includes("edge ready"), false);
  assert.equal(events.includes("rollback"), false);
  assert.equal(events.at(-1), "cleanup runner");
});

for (const failAt of ["API ready", "edge ready", "ALB healthy", "external smoke"]) {
  test(`post-switch ${failAt} failure restores the exact previous digest pair`, async () => {
    const { dependencies, calls, events } = fixture({ failAt });

    await assert.rejects(deployRelease(dependencies, MANIFEST), new RegExp(`${failAt} failed`));

    const rollback = calls.find((call) => call.name === "rollback");
    assert.deepEqual(rollback.payload, { api: PREVIOUS_API, edge: PREVIOUS_EDGE });
    assert.ok(events.indexOf("rollback") > events.indexOf(failAt));
    assert.equal(events.at(-1), "cleanup runner");
  });
}
