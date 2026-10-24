import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withUpgradeState, withUpgradePhaseState } from "../host/upgrade-state.mjs";
import { createUpgradeObservers } from "../host/upgrade-observation.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
import { upgradeOldRuntime, upgradePreparation, upgradeHash } from "./upgrade-fixture.mjs";
const patch = {
  MARKIRO_RELEASES_BUCKET: "markiro-releases",
  RELEASE_CATALOG_S3_ENDPOINT: "https://s3.twcstorage.ru",
  RELEASE_CATALOG_S3_REGION: "ru-1",
  RELEASE_CATALOG_S3_BUCKET: "markiro-releases",
  RELEASE_CATALOG_S3_ACCESS_KEY_ID: "fixture",
  RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "private-fixture",
  RELEASE_CATALOG_CACHE_DIR: "/opt/markiro-platform/release-catalog/cache",
  RELEASE_CATALOG_JOURNAL_DIR: "/opt/markiro-platform/release-catalog/journal",
  RELEASE_CATALOG_CACHE_BYTES: "1048576",
  RELEASE_CATALOG_OBJECT_BYTES: "524288",
  RELEASE_CATALOG_DISK_RESERVE_BYTES: "1048576",
  RELEASE_CATALOG_DOWNLOADS: "2",
  RELEASE_CATALOG_TIMEOUT_MS: "30000",
  RELEASE_CATALOG_WRITERS_ENABLED: "false",
};
async function fixture(t, phase = "activate") {
  const f = await upgradeObservationFixture(t, { candidatePatch: patch });
  const old = upgradeOldRuntime(f.input);
  old.containers = f.predecessorContainers;
  const proof = upgradePreparation(f.input, old);
  await withUpgradeState(
    f.root,
    f.input,
    async (s) => {
      await s.complete("admitted", old);
      await s.enter("old-stopped");
      f.stop();
      await s.complete("old-stopped");
      await s.enter("backup-verified");
      await s.complete("backup-verified", proof.backup, proof);
    },
    { now: () => f.now },
  );
  const b = await readFile(
    join(f.root, "upgrade-operations", f.input.identity.operationId, "state.json"),
  );
  const decision = {
    version: 1,
    kind: "platform-upgrade-phase",
    phase,
    identity: f.input.identity,
    prior: { sequence: 6, sha256: upgradeHash(b) },
    executorCi: f.input.executorCi,
    reviewedPlanSha256: f.input.reviewedPlanSha256,
    dispatch: { ...f.input.dispatch, runId: "987654333" },
    expiresAt: f.input.expiresAt,
  };
  return { ...f, decision, observer: createUpgradeObservers(f, f.dependencies) };
}
function replace(f, service) {
  const index = service === "api" ? 1 : 2;
  const c = f.d.state.containers[index];
  c.Id = (service === "api" ? "6" : "7").repeat(64);
  c.State = {
    Running: true,
    Restarting: false,
    Paused: false,
    Status: "running",
    Health: { Status: "healthy" },
  };
  if (service === "api") {
    const extra = c.Config.Env.filter((p) => !Object.hasOwn(f.oldEnv, p.slice(0, p.indexOf("="))));
    c.Config.Env = [...Object.entries(f.candidateEnv).map(([k, v]) => `${k}=${v}`), ...extra];
    c.Mounts.push(
      ...["cache", "journal"].map((n) => ({
        Type: "bind",
        Source: `/opt/markiro-platform/release-catalog/${n}`,
        Destination: `/opt/markiro-platform/release-catalog/${n}`,
        RW: true,
      })),
    );
  } else
    c.Config.Env.push(
      `MARKIRO_RELEASES_DOMAIN=${f.candidateEnv.MARKIRO_RELEASES_DOMAIN}`,
      `MARKIRO_RELEASES_BUCKET=${f.candidateEnv.MARKIRO_RELEASES_BUCKET}`,
    );
  return c;
}
const run = (f, action) => withUpgradePhaseState(f.root, f.decision, action, { now: () => f.now });

test("activation before latch observes exact stopped old authority", async (t) => {
  const f = await fixture(t);
  await run(f, (s) => s.guard(f.observer.inspectStoppedOld));
});
test("candidate phase validates retained stopped old edge alongside new catalog API", async (t) => {
  const f = await fixture(t);
  await run(f, async (s) => {
    await s.complete("activation-admitted");
    await s.enter("migration-entered");
    assert.deepEqual(
      (await s.guard(f.observer.inspectCandidate)).containers,
      f.predecessorContainers,
    );
    await s.complete("migration-entered");
    await s.enter("migrated");
    await s.complete("migrated");
    await s.enter("api-started");
    const api = replace(f, "api");
    assert.equal((await s.guard(f.observer.inspectCandidate)).containers.api, api.Id);
    await s.complete("api-started");
    await s.enter("edge-started");
    const edge = replace(f, "edge");
    assert.equal((await s.guard(f.observer.inspectCandidate)).containers.edge, edge.Id);
    await s.complete("edge-started");
    await s.enter("healthy");
    await s.guard(f.observer.inspectCandidate);
    await s.complete("healthy");
  });
});
for (const mutation of [
  "running old",
  "old ID candidate env",
  "foreign new ID old env",
  "duplicate service",
  "new edge too early",
  "old changed mount",
])
  test(`mixed phase refuses ${mutation}`, async (t) => {
    const f = await fixture(t);
    await run(f, async (s) => {
      await s.complete("activation-admitted");
      await s.enter("migration-entered");
      if (mutation === "running old") f.d.state.containers[1].State.Running = true;
      if (mutation === "old ID candidate env") {
        const oldId = f.predecessorContainers.api;
        replace(f, "api").Id = oldId;
        f.d.state.containers[1].State.Running = false;
      }
      if (mutation === "foreign new ID old env") f.d.state.containers[1].Id = "6".repeat(64);
      if (mutation === "duplicate service")
        f.d.state.containers.push(structuredClone(f.d.state.containers[1]));
      if (mutation === "new edge too early") replace(f, "edge");
      if (mutation === "old changed mount") f.d.state.containers[2].Mounts[0].Name += "-other";
      await assert.rejects(s.guard(f.observer.inspectCandidate));
    });
  });

test("fresh return observes only exact complete old authority through both starts", async (t) => {
  const f = await fixture(t, "return-old");
  await run(f, async (s) => {
    await s.guard(f.observer.inspectReturnEligibility);
    await s.complete("return-admitted");
    await s.enter("old-api-started");
    f.d.state.containers[1].State.Running = true;
    await s.guard(f.observer.inspectReturnEligibility);
    await s.complete("old-api-started");
    await s.enter("old-edge-started");
    f.d.state.containers[2].State.Running = true;
    await s.guard(f.observer.inspectReturnEligibility);
    await s.complete("old-edge-started");
    await s.enter("returned-old");
    await s.guard(f.observer.inspectReturnEligibility);
    await s.complete("returned-old");
  });
});
