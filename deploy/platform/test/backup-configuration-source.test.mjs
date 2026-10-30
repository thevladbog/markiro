import assert from "node:assert/strict";
import test from "node:test";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { chainFixture } from "./configuration-chain-fixture.mjs";
import { withCurrentConfigurationSource } from "../backup/configuration-source.mjs";

async function fixture(t) {
  const f = await chainFixture(t);
  const bytes = Buffer.from(
    JSON.stringify({ version: 1, sequence: 0, current: null, previousHealthy: null }) + "\n",
  );
  await writeFile(join(f.root, "state.json"), bytes);
  f.records[0].plan.guards.find((g) => g.path === "state/state.json").sha256 = digest(bytes);
  await f.save();
  return f;
}

test("backup source binds the accepted replacement API while retaining worker provenance", async (t) => {
  const f = await fixture(t);
  let saved;
  const result = await withCurrentConfigurationSource(
    { root: f.root, baseline: f.baseline, expectedHead: f.index.head },
    async (context) => {
      await access(join(f.root, ".deploy.lock"));
      assert.deepEqual(context.current.api, f.records[0].receipt.after.api);
      assert.equal(context.current.acceptedOperationId, f.baseline.acceptedOperationId);
      assert.ok(Object.isFrozen(context.current.api));
      await context.verify();
      saved = context;
      return "backup-source-verified";
    },
  );
  assert.equal(result, "backup-source-verified");
  await assert.rejects(access(join(f.root, ".deploy.lock")));
  await assert.rejects(saved.verify());
});

test("backup source denies old head and never starts producer during configuration uncertainty", async (t) => {
  const f = await fixture(t);
  let called = false;
  await assert.rejects(
    withCurrentConfigurationSource(
      { root: f.root, baseline: f.baseline, expectedHead: null },
      async () => {
        called = true;
      },
    ),
  );
  assert.equal(called, false);
  await writeFile(join(f.root, "config-pending.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(
    withCurrentConfigurationSource(
      { root: f.root, baseline: f.baseline, expectedHead: f.index.head },
      async () => {
        called = true;
      },
    ),
  );
  assert.equal(called, false);
});

test("real backup runtime refuses a successor without held source authority before touching Docker", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await writeFile(
    join(f.root, "backup-runtime.json"),
    JSON.stringify({
      version: 1,
      executorSha: "a".repeat(40),
      dockerExecutable: "/usr/bin/docker",
      endpoint: "unix:///var/run/docker.sock",
      image: `sha256:${"b".repeat(64)}`,
      provenance: "live-source",
    }),
    { mode: 0o600 },
  );
  const { openRuntime } = await import("../backup/local-runtime.mjs");
  await assert.rejects(
    openRuntime({
      root: f.root,
      operationId: "11111111-1111-4111-8111-111111111111",
      purpose: "archive",
      run: async () => {
        calls++;
        throw new Error("must not run");
      },
    }),
  );
  assert.equal(calls, 0);
});

test("backup source token is scoped to its root, guarded lifetime and immutable head", async (t) => {
  const f = await fixture(t);
  const { assertCurrentBackupConfiguration } = await import("../backup/configuration-source.mjs");
  let saved;
  await withCurrentConfigurationSource(
    { root: f.root, baseline: f.baseline, expectedHead: f.index.head },
    async (context) => {
      saved = context;
      await assertCurrentBackupConfiguration(f.root, context);
      await assert.rejects(assertCurrentBackupConfiguration(f.root, { ...context }));
      await assert.rejects(assertCurrentBackupConfiguration(f.host, context));
    },
  );
  await assert.rejects(assertCurrentBackupConfiguration(f.root, saved));
});

test("real worker runtime accepts held current-source token without relabeling its image or executor", async (t) => {
  const f = await fixture(t),
    image = `sha256:${"b".repeat(64)}`,
    executorSha = "a".repeat(40);
  const descriptor = {
    version: 1,
    executorSha,
    dockerExecutable: "/usr/bin/docker",
    endpoint: "unix:///var/run/docker.sock",
    image,
    provenance: "live-source",
  };
  await writeFile(join(f.root, "backup-runtime.json"), JSON.stringify(descriptor), { mode: 0o600 });
  const { openRuntime } = await import("../backup/local-runtime.mjs");
  let calls = 0,
    saved;
  const run = async () => {
    calls++;
    return {
      stdout: Buffer.from(
        JSON.stringify([
          {
            Id: image,
            Os: "linux",
            Architecture: "amd64",
            Config: { Volumes: { "/var/lib/postgresql/data": {} } },
          },
        ]),
      ),
      stderr: Buffer.alloc(0),
    };
  };
  await withCurrentConfigurationSource(
    { root: f.root, baseline: f.baseline, expectedHead: f.index.head },
    async (context) => {
      saved = await openRuntime({
        root: f.root,
        operationId: "11111111-1111-4111-8111-111111111111",
        purpose: "archive",
        run,
        configurationSource: context,
      });
      assert.equal(saved.config.image, image);
      assert.equal(saved.config.executorSha, executorSha);
      assert.equal(calls, 1);
      await saved.command(["image", "inspect", image]);
      assert.equal(calls, 2);
    },
  );
  await assert.rejects(saved.command(["image", "inspect", image]));
  assert.equal(calls, 2);
});

test("internal backup capability producer rejects fabricated and expired held-host capabilities", async (t) => {
  const f = await fixture(t);
  let verified = false,
    called = false,
    expired;
  const { withBackupConfigurationCapability } =
    await import("../backup/configuration-capability.mjs");
  const { withHostState } = await import("../host/state.mjs");
  const request = {
    root: f.root,
    current: f.baseline,
    verify: async () => {
      verified = true;
    },
  };
  await assert.rejects(
    withBackupConfigurationCapability({}, request, async () => {
      called = true;
    }),
  );
  await withHostState(f.root, (store) =>
    store.guardPersistence(async (cap) => {
      expired = cap;
    }),
  );
  await assert.rejects(
    withBackupConfigurationCapability(expired, request, async () => {
      called = true;
    }),
  );
  assert.equal(verified, false);
  assert.equal(called, false);
});
