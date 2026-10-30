import { chainFixture } from "./configuration-chain-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { envBytes, privateFixture } from "./host-fixtures.mjs";

const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const api = (n) => ({
  id: n.toString(16).padStart(64, "0"),
  imageId: `sha256:${"b".repeat(64)}`,
  recipeSha256: n.toString(16).padStart(64, "c"),
});
const authorization = {
  actorId: "1",
  actorLogin: "actor",
  reviewerId: "2",
  reviewerLogin: "reviewer",
  environmentId: "3",
};

test("configuration resolver preserves the accepted legacy descriptor when no index exists", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const { root } = await privateFixture(t, { nested: true });
  const baseline = {
    acceptedOperationId: "10000000-0000-4000-8000-000000000001",
    api: { id: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, recipeSha256: "c".repeat(64) },
    runtime: { path: join(root, "source.env"), sha256: "d".repeat(64) },
  };
  assert.equal(await resolveConfigurationRuntime({ root, baseline }), baseline);
});

test("a pending configuration blocks legacy resolution even before the index exists", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const { root } = await privateFixture(t, { nested: true });
  await writeFile(join(root, "config-pending.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(resolveConfigurationRuntime({ root, baseline: {} }), /configuration/i);
});

test("resolves two independently authorized configuration successors", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 2);
  const result = await resolveConfigurationRuntime(f);
  assert.deepEqual(result, {
    acceptedOperationId: f.baseline.acceptedOperationId,
    api: api(3),
    runtime: f.records[1].plan.runtime,
  });
});

test("accepts a verified returned-old identity while retaining its old private runtime", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 1, ["returned-old"]);
  assert.deepEqual(await resolveConfigurationRuntime(f), { ...f.baseline, api: api(2) });
});

for (const [name, mutate] of [
  [
    "self approval",
    (f) => {
      f.records[0].receipt.authorization.reviewerId = "1";
    },
  ],
  [
    "rerun dispatch",
    (f) => {
      f.records[0].receipt.dispatch.runAttempt = "2";
    },
  ],
  [
    "different executor",
    (f) => {
      f.records[0].receipt.dispatch.toolingSha = "f".repeat(40);
    },
  ],
  [
    "changed API image",
    (f) => {
      f.records[0].receipt.after.api.imageId = `sha256:${"a".repeat(64)}`;
    },
  ],
  [
    "same container identity",
    (f) => {
      f.records[0].receipt.after.api.id = f.baseline.api.id;
    },
  ],
  [
    "retained worker substituted for replacement API",
    (f) => {
      f.records[0].receipt.after.api = api(102);
    },
  ],
  [
    "unknown receipt field",
    (f) => {
      f.records[0].receipt.unreviewed = true;
    },
  ],
  [
    "unknown index field",
    (f) => {
      f.index.unreviewed = true;
    },
  ],
  [
    "nonterminal receipt",
    (f) => {
      f.records[0].receipt.status = "entered";
    },
  ],
  [
    "changed accepted predecessor",
    (f) => {
      f.records[0].receipt.acceptedOperationId = randomUUID();
    },
  ],
  [
    "changed baseline",
    (f) => {
      f.baseline.api = api(90);
    },
  ],
  [
    "runtime path escape",
    (f) => {
      f.records[0].receipt.after.runtime.path = "/etc/passwd";
    },
  ],
  [
    "returned-old with candidate environment",
    (f) => {
      f.records[0].receipt.status = "returned-old";
    },
  ],
  [
    "unpaired previous pointer",
    (f) => {
      f.records[0].receipt.previousOperationId = randomUUID();
    },
  ],
])
  test(`rejects ${name}`, async (t) => {
    const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
    const f = await chainFixture(t);
    mutate(f);
    await f.save();
    await assert.rejects(resolveConfigurationRuntime(f), { code: "ERR_HOST_CONFIGURATION_CHAIN" });
  });

test("hashes exact receipt bytes and refuses changed private history", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t);
  await writeFile(
    join(f.records[0].directory, "receipt.json"),
    Buffer.concat([encode(f.records[0].receipt), Buffer.from(" ")]),
  );
  await assert.rejects(resolveConfigurationRuntime(f));
});

test("binds exact plan bytes rather than a plaintext terminal receipt", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t);
  await writeFile(
    join(f.records[0].directory, "operation.json"),
    encode({ ...f.records[0].plan, executorSha: "f".repeat(40) }),
  );
  await assert.rejects(resolveConfigurationRuntime(f));
});

for (const alteration of ["guard", "runtime", "unsafe-mode", "symlink", "missing-receipt"])
  test(`rejects ${alteration} tampering`, async (t) => {
    const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
    const f = await chainFixture(t);
    const runtime = f.records[0].plan.runtime.path;
    if (alteration === "guard") await writeFile(join(f.host, "guard.json"), "changed\n");
    if (alteration === "runtime") await writeFile(runtime, "DADATA_TOKEN=changed\n");
    if (alteration === "unsafe-mode") await chmod(runtime, 0o644);
    if (alteration === "symlink") {
      await unlink(runtime);
      await symlink(f.envFile, runtime);
    }
    if (alteration === "missing-receipt")
      await unlink(join(f.records[0].directory, "receipt.json"));
    await assert.rejects(resolveConfigurationRuntime(f), { code: "ERR_HOST_CONFIGURATION_CHAIN" });
  });

test("rejects a complete rehashed environment change beyond DaData without exposing values", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t);
  const privateValue = "private-fixture-changed-value";
  const bytes = envBytes({ ...f.env, DADATA_TOKEN: "fixture-token", SMTP_PASSWORD: privateValue });
  await writeFile(f.records[0].plan.runtime.path, bytes);
  f.records[0].plan.runtime.sha256 = digest(bytes);
  await f.save();
  await assert.rejects(resolveConfigurationRuntime(f), (error) => {
    assert.equal(error.code, "ERR_HOST_CONFIGURATION_CHAIN");
    assert.equal(String(error).includes(privateValue), false);
    assert.equal(String(error).includes("fixture-token"), false);
    return true;
  });
});

test("rejects conflicting successor continuity even when every document is rehashed", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 2);
  f.records[1].plan.before.api = api(90);
  f.records[1].receipt.before.api = api(90);
  await f.save();
  await assert.rejects(resolveConfigurationRuntime(f));
});

test("follows exact previous receipt hashes and refuses reordered history", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 2);
  f.records[1].receipt.previousReceiptSha256 = "f".repeat(64);
  f.records[1].plan.previousReceiptSha256 = "f".repeat(64);
  await f.save();
  await assert.rejects(resolveConfigurationRuntime(f));
});

test("limits the accepted chain to 32 terminal successors", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 33);
  await assert.rejects(resolveConfigurationRuntime(f));
});

test("accepts exactly 32 verified successors", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 32);
  const result = await resolveConfigurationRuntime(f);
  assert.deepEqual(result.api, api(33));
  assert.deepEqual(result.runtime, f.records[31].plan.runtime);
});

test("a returned-old successor can be followed by a fresh healthy operation", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 2, ["returned-old", "healthy"]);
  const result = await resolveConfigurationRuntime(f);
  assert.deepEqual(result.api, api(3));
  assert.deepEqual(result.runtime, f.records[1].plan.runtime);
});

test("unapplied staged plans do not supersede the accepted legacy runtime", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t);
  await unlink(join(f.root, "config-index.json"));
  await unlink(join(f.records[0].directory, "receipt.json"));
  assert.equal(await resolveConfigurationRuntime(f), f.baseline);
});

test("pending marker blocks a previously accepted chain", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t);
  await writeFile(join(f.root, "config-pending.json"), "{}\n", { mode: 0o600 });
  await assert.rejects(resolveConfigurationRuntime(f));
});

for (const [name, mutate] of [
  [
    "an earlier API identity reused",
    (f) => {
      f.records[1].receipt.after.api = api(1);
    },
  ],
  [
    "an earlier protected workflow run reused",
    (f) => {
      f.records[1].receipt.dispatch.runId = "10";
    },
  ],
  [
    "an operation linked to itself",
    (f) => {
      f.records[1].plan.previousOperationId = f.records[1].receipt.operationId;
      f.records[1].receipt.previousOperationId = f.records[1].receipt.operationId;
    },
  ],
  [
    "plan predecessor differs from terminal receipt",
    (f) => {
      f.records[1].plan.before.api = api(90);
    },
  ],
])
  test(`rejects ${name}`, async (t) => {
    const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
    const f = await chainFixture(t, 2);
    mutate(f);
    await f.save();
    await assert.rejects(resolveConfigurationRuntime(f));
  });

test("a failed operation cannot bypass environment restrictions by returning old", async (t) => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  const f = await chainFixture(t, 1, ["returned-old"]);
  const candidate = f.records[0].plan.runtime;
  const bytes = envBytes({
    ...f.env,
    SMTP_HOST: "changed.example.org",
    DADATA_TOKEN: "fixture-token",
  });
  await writeFile(candidate.path, bytes);
  candidate.sha256 = digest(bytes);
  await f.save();
  await assert.rejects(resolveConfigurationRuntime(f));
});

test("generic rejection never executes caller accessors", async () => {
  const { resolveConfigurationRuntime } = await import("../host/configuration-chain.mjs");
  let executed = false;
  const input = { baseline: {} };
  Object.defineProperty(input, "root", {
    enumerable: true,
    get() {
      executed = true;
      throw new Error("private-value");
    },
  });
  await assert.rejects(resolveConfigurationRuntime(input), {
    code: "ERR_HOST_CONFIGURATION_CHAIN",
  });
  assert.equal(executed, false);
});
