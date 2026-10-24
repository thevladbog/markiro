import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import test from "node:test";
import { createUpgradeObservers } from "../host/upgrade-observation.mjs";
import { withUpgradeState, withHeldUpgradeState } from "../host/upgrade-state.mjs";
import { withHostState } from "../host/state.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
const run = (f, action) => withUpgradeState(f.root, f.input, action, { now: () => f.now });
const observer = (f) => createUpgradeObservers(f, f.dependencies);

test("old full authority accepts same-image candidate with different config without substituting it", async (t) => {
  const f = await upgradeObservationFixture(t);
  const o = observer(f);
  assert.equal(
    f.oldOperation.identity.admission.registry.api.imageId,
    f.candidateOperation.identity.admission.registry.api.imageId,
  );
  await run(f, async (store) => {
    const value = await store.guard(o.inspectOld);
    assert.equal(value.containers.api, f.predecessorContainers.api);
    assert.equal(value.configurationSha256, f.input.oldConfigurationSha256);
  });
});
test("stopped old observation requires both exact retained IDs and no running applications", async (t) => {
  const f = await upgradeObservationFixture(t);
  const o = observer(f);
  await run(f, async (store) => {
    await assert.rejects(store.guard(o.inspectStoppedOld));
    f.stop();
    const value = await store.guard(o.inspectStoppedOld);
    assert.deepEqual(value.containers, f.predecessorContainers);
  });
});
for (const [name, change] of Object.entries({
  "mixed candidate env": (f) =>
    f.d.state.containers[1].Config.Env.push("MARKIRO_RELEASES_DOMAIN=releases.markiro.app"),
  "extra catalog mount": (f) =>
    f.d.state.containers[1].Mounts.push({
      Type: "bind",
      Source: "/opt/markiro-platform/release-catalog/cache",
      Destination: "/opt/markiro-platform/release-catalog/cache",
      RW: true,
    }),
  "changed CA mount": (f) => (f.d.state.containers[1].Mounts[0].Source += ".other"),
  "changed network": (f) =>
    (f.d.state.containers[1].NetworkSettings.Networks[f.policy.networks.database.name].NetworkID =
      "f".repeat(64)),
  "changed port": (f) =>
    (f.d.state.containers[2].HostConfig.PortBindings["8443/tcp"][0].HostPort = "444"),
  "changed entrypoint": (f) => (f.d.state.containers[2].Config.Entrypoint = ["sh"]),
  "recreated API": (f) => (f.d.state.containers[1].Id = "7".repeat(64)),
  "missing edge": (f) => f.d.state.containers.pop(),
  "extra owned API": (f) =>
    f.d.state.containers.push({ ...structuredClone(f.d.state.containers[1]), Id: "7".repeat(64) }),
  "foreign running workload": (f) =>
    f.d.state.containers.push({
      ...structuredClone(f.d.state.containers[1]),
      Id: "7".repeat(64),
      Config: { Labels: {} },
    }),
  "changed PG volume": (f) => (f.d.state.volume.CreatedAt = "2026-10-19T00:00:00Z"),
  "changed PG system": (f) => f.setDatabaseId("987654321"),
  "paused PG": (f) => (f.d.state.containers[0].State.Paused = true),
  "changed snapshot": async (f) =>
    appendFile(f.oldOperation.configuration.runtimeSnapshot.path, "UNEXPECTED=value\n"),
}))
  test(`old authority rejects ${name}`, async (t) => {
    const f = await upgradeObservationFixture(t);
    const o = observer(f);
    await change(f);
    await run(f, async (store) => {
      await assert.rejects(store.guard(o.inspectOld));
    });
  });
test("forged, ordinary and expired capabilities cannot inspect or run Docker", async (t) => {
  const f = await upgradeObservationFixture(t);
  const o = observer(f);
  await assert.rejects(o.inspectOld({}));
  await withHostState(f.root, (host) =>
    host.guardPersistence(async (cap) => {
      await assert.rejects(o.inspectOld(cap));
    }),
  );
  let retained;
  await run(f, async (store) => {
    await store.guard(async (cap) => {
      retained = cap;
      await withHeldUpgradeState(cap, (held) => {
        assert.equal(held.state.admission.identity.operationId, f.input.identity.operationId);
      });
    });
  });
  await assert.rejects(o.inspectOld(retained));
  assert.equal(f.commands.length, 0);
});
test("prepare capability cannot admit candidate or authorize old return", async (t) => {
  const f = await upgradeObservationFixture(t);
  const o = observer(f);
  f.stop();
  await run(f, async (store) => {
    await assert.rejects(store.guard(o.inspectCandidate));
    await assert.rejects(store.guard(o.inspectReturnEligibility));
  });
  assert.equal(f.commands.length, 0);
});
test("operation identity/configuration substitution is rejected before commands", async (t) => {
  const f = await upgradeObservationFixture(t);
  f.oldOperation.configuration = f.candidateOperation.configuration;
  const o = observer(f);
  await run(f, async (store) => {
    await assert.rejects(store.guard(o.inspectOld));
  });
  assert.equal(f.commands.length, 0);
});

test("authority changed during a Docker await prevents the next command", async (t) => {
  const f = await upgradeObservationFixture(t);
  const original = f.dependencies.runProcess;
  f.dependencies.runProcess = async (request) => {
    const result = await original(request);
    await appendFile(f.candidateOperation.configuration.runtimeSnapshot.path, "UNEXPECTED=value\n");
    return result;
  };
  const o = observer(f);
  await run(f, async (store) => {
    await assert.rejects(store.guard(o.inspectOld));
  });
  assert.equal(f.commands.length, 1);
});
test("expired admission during a Docker await prevents the next command", async (t) => {
  const f = await upgradeObservationFixture(t);
  const original = f.dependencies.runProcess;
  f.dependencies.runProcess = async (request) => {
    const result = await original(request);
    f.now = Date.parse(f.input.expiresAt);
    return result;
  };
  const o = observer(f);
  await run(f, async (store) => {
    await assert.rejects(store.guard(o.inspectOld));
  });
  assert.equal(f.commands.length, 1);
});

for (const candidatePatch of [
  { MARKIRO_RELEASES_DOMAIN: "" },
  { MARKIRO_RELEASES_BUCKET: "" },
  { MARKIRO_POSTGRES_SERVER_CERT_FILE: "/other/certificate" },
  { RELEASE_CATALOG_CACHE_DIR: "/opt/markiro-platform/release-catalog/cache" },
])
  test(`invalid candidate blocked before old-runtime preparation: ${Object.keys(candidatePatch)[0]}`, async (t) => {
    const f = await upgradeObservationFixture(t, { candidatePatch });
    const o = observer(f);
    await run(f, async (store) => {
      await assert.rejects(store.guard(o.inspectOld));
    });
    assert.equal(f.commands.length, 0);
  });

const catalogPatch = {
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
test("new catalog config/mounts do not contaminate observation of still-running old apps", async (t) => {
  const f = await upgradeObservationFixture(t, { candidatePatch: catalogPatch });
  await run(f, (store) => store.guard(observer(f).inspectOld));
});
for (const mode of [
  "exact candidate",
  "missing candidate release variable",
  "old env under candidate image",
  "missing catalog mount",
  "extra old mount",
]) {
  test(`strict candidate observation: ${mode}`, async (t) => {
    const { createHostObservers } = await import("../host/observe.mjs");
    const f = await upgradeObservationFixture(t, { candidatePatch: catalogPatch });
    const api = f.d.state.containers[1],
      edge = f.d.state.containers[2];
    if (mode !== "old env under candidate image") {
      const extra = api.Config.Env.filter(
        (pair) => !Object.hasOwn(f.oldEnv, pair.slice(0, pair.indexOf("="))),
      );
      api.Config.Env = [...Object.entries(f.candidateEnv).map(([k, v]) => `${k}=${v}`), ...extra];
      edge.Config.Env.push(
        `MARKIRO_RELEASES_DOMAIN=${f.candidateEnv.MARKIRO_RELEASES_DOMAIN}`,
        `MARKIRO_RELEASES_BUCKET=${f.candidateEnv.MARKIRO_RELEASES_BUCKET}`,
      );
    }
    api.Mounts.push(
      ...["cache", "journal"].map((n) => ({
        Type: "bind",
        Source: `/opt/markiro-platform/release-catalog/${n}`,
        Destination: `/opt/markiro-platform/release-catalog/${n}`,
        RW: true,
      })),
    );
    if (mode === "missing candidate release variable")
      edge.Config.Env = edge.Config.Env.filter((v) => !v.startsWith("MARKIRO_RELEASES_DOMAIN="));
    if (mode === "missing catalog mount") api.Mounts.pop();
    if (mode === "extra old mount")
      api.Mounts.push({ Type: "bind", Source: "/old/path", Destination: "/old", RW: false });
    const action = () =>
      createHostObservers(f.candidateOperation, f.policy, f.dependencies).inventory({
        ...f.d.context,
        allowedServices: ["postgres", "api", "edge"],
        phase: "edge-started",
        previousHealthy: null,
      });
    if (mode === "exact candidate") assert.equal((await action()).owned.length, 3);
    else await assert.rejects(action());
  });
}

test("held upgrade verifier expires when its own guarded inspection finishes", async (t) => {
  const f = await upgradeObservationFixture(t);
  let retained;
  await run(f, async (store) => {
    await store.guard((cap) =>
      withHeldUpgradeState(cap, (held) => {
        retained = held.verify;
      }),
    );
    await assert.rejects(retained());
  });
});

test("observations reject a retained-ID set differing from the durable pre-stop record", async (t) => {
  const { upgradeOldRuntime } = await import("./upgrade-fixture.mjs");
  const f = await upgradeObservationFixture(t);
  const value = upgradeOldRuntime(f.input);
  value.containers.api = "7".repeat(64);
  const o = observer(f);
  await run(f, async (store) => {
    await store.complete("admitted", value);
    await assert.rejects(store.guard(o.inspectOld));
  });
  assert.equal(f.commands.length, 0);
});
test("backup source observation returns the actual verified PG HBA mount with stopped authority", async (t) => {
  const f = await upgradeObservationFixture(t);
  f.stop();
  const expected = f.d.state.containers[0].Mounts.find(
    (m) => m.Destination === "/etc/postgresql/pg_hba.conf",
  ).Source;
  await run(f, async (store) => {
    const result = await store.guard(observer(f).inspectBackupSource);
    assert.equal(result.hbaPath, expected);
    assert.deepEqual(result.observation.containers, f.predecessorContainers);
  });
});

test("upgrade fixtures keep the predecessor operation inside an executor-owned private parent", async (t) => {
  const { dirname } = await import("node:path");
  const { assertPrivateRootSync } = await import("../host/files.mjs");
  const f = await upgradeObservationFixture(t);
  assertPrivateRootSync(dirname(f.root));
  assert.equal(f.root.endsWith("/state"), true);
});
