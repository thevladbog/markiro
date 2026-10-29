import test from "node:test";
import assert from "node:assert/strict";
import { containerRecipe } from "../catalog-bootstrap-host.mjs";
function api() {
  return {
    Config: {
      Env: [
        "DATABASE_URL=postgres://example@postgres/markiro?sslmode=verify-full&sslrootcert=/run/markiro-postgres/ca.crt",
      ],
    },
    HostConfig: {
      Mounts: [
        { Target: "/b", Source: "/source/b" },
        { Target: "/a", Source: "/source/a" },
      ],
    },
    Image: "sha256:" + "a".repeat(64),
    Mounts: [
      {
        Type: "bind",
        Source: "/opt/markiro-platform/state/postgres/ca.crt",
        Destination: "/run/markiro-postgres/ca.crt",
        RW: false,
      },
      {
        Type: "bind",
        Source: "/opt/markiro-platform/release-catalog/cache",
        Destination: "/opt/markiro-platform/release-catalog/cache",
        RW: true,
      },
    ],
  };
}
test("identical Docker mount sets hash equally without dropping fields or mutating the observation", () => {
  const a = api(),
    b = structuredClone(a),
    before = structuredClone(a);
  b.Mounts.reverse();
  b.HostConfig.Mounts.reverse();
  assert.equal(containerRecipe(a), containerRecipe(b));
  assert.deepEqual(a, before);
  b.Mounts[0].RW = false;
  assert.notEqual(containerRecipe(a), containerRecipe(b));
  const duplicate = api();
  duplicate.Mounts.push(structuredClone(duplicate.Mounts[0]));
  assert.throws(() => containerRecipe(duplicate));
});
test("actual worker argv retains only the accepted readonly PostgreSQL CA and uses the official Node executable", async () => {
  const { postgresCaMount, readBootstrapWorkerArguments } =
    await import("../catalog-bootstrap-policy.mjs");
  const a = api(),
    operation = {
      operationId: "de7a478d-e712-45bb-b36f-40067a62ab1d",
      networkId: "b".repeat(64),
      egressNetworkId: "c".repeat(64),
      containers: { api: { imageId: a.Image } },
    };
  const args = readBootstrapWorkerArguments({
    operation,
    root: `/opt/markiro-platform/catalog-bootstrap-operations/${operation.operationId}`,
    api: a,
  });
  assert.equal(args[args.indexOf("--entrypoint") + 1], "/usr/local/bin/node");
  assert.equal(args[args.indexOf("--network") + 1], operation.egressNetworkId);
  assert.ok(
    args.includes(
      "type=bind,source=/opt/markiro-platform/state/postgres/ca.crt,target=/run/markiro-postgres/ca.crt,readonly",
    ),
  );
  assert.equal(args.filter((s) => s.includes("target=/run/markiro-postgres/")).length, 1);
  assert.equal(postgresCaMount(a).RW, false);
  for (const mutate of [
    (c) => {
      c.Mounts[0].RW = true;
    },
    (c) => {
      c.Mounts[0].Source = "/outside/ca.crt";
    },
    (c) => {
      c.Config.Env[0] = c.Config.Env[0].replace("verify-full", "require");
    },
    (c) => {
      c.Config.Env[0] = c.Config.Env[0].replace("ca.crt", "other.crt");
    },
  ]) {
    const c = api();
    mutate(c);
    assert.throws(() =>
      readBootstrapWorkerArguments({
        operation,
        root: "/opt/markiro-platform/catalog-bootstrap-operations/test",
        api: c,
      }),
    );
  }
});

test("CA owner matches the accepted node-readable file without allowing writable or unreadable TLS inputs", async () => {
  const { validateBootstrapCaFile } = await import("../catalog-bootstrap-policy.mjs");
  for (const value of [
    { uid: 1000, gid: 1000, mode: 0o600, size: 1200 },
    { uid: 0, gid: 0, mode: 0o644, size: 1200 },
    { uid: 0, gid: 1000, mode: 0o640, size: 1200 },
  ])
    assert.doesNotThrow(() => validateBootstrapCaFile(value));
  for (const value of [
    { uid: 0, gid: 0, mode: 0o600, size: 1200 },
    { uid: 1000, gid: 1000, mode: 0o666, size: 1200 },
    { uid: 2000, gid: 1000, mode: 0o640, size: 1200 },
  ])
    assert.throws(() => validateBootstrapCaFile(value));
});

test("worker joins exactly the accepted API egress and internal database networks before start", async () => {
  const { validateReadBootstrapNetworks, readBootstrapWorkerDatabaseArguments } =
    await import("../catalog-bootstrap-policy.mjs");
  const operation = { networkId: "b".repeat(64), egressNetworkId: "c".repeat(64) };
  const network = (name, id, internal) => ({
    Id: id,
    Name: `markiro-platform_${name}`,
    Driver: "bridge",
    Scope: "local",
    Internal: internal,
    Attachable: false,
    Ingress: false,
    Labels: {
      "com.docker.compose.project": "markiro-platform",
      "com.docker.compose.network": name,
    },
  });
  const fixture = () => ({
    api: {
      NetworkSettings: {
        Networks: {
          default: { NetworkID: operation.egressNetworkId },
          database: { NetworkID: operation.networkId },
        },
      },
    },
    postgres: { NetworkSettings: { Networks: { database: { NetworkID: operation.networkId } } } },
    networks: [
      network("database", operation.networkId, true),
      network("default", operation.egressNetworkId, false),
    ],
  });
  assert.doesNotThrow(() => validateReadBootstrapNetworks(operation, fixture()));
  const attached = fixture();
  attached.worker = structuredClone(attached.api);
  assert.doesNotThrow(() => validateReadBootstrapNetworks(operation, attached));
  delete attached.worker.NetworkSettings.Networks.default;
  assert.throws(() => validateReadBootstrapNetworks(operation, attached));
  for (const mutate of [
    (f) => delete f.api.NetworkSettings.Networks.default,
    (f) => (f.api.NetworkSettings.Networks.extra = { NetworkID: "d".repeat(64) }),
    (f) => (f.postgres.NetworkSettings.Networks.default = { NetworkID: operation.egressNetworkId }),
    (f) => (f.networks[0].Internal = false),
    (f) => (f.networks[1].Internal = true),
    (f) => (f.networks[1].Labels["com.docker.compose.project"] = "other"),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateReadBootstrapNetworks(operation, f));
  }
  assert.deepEqual(readBootstrapWorkerDatabaseArguments(operation, "d".repeat(64)), [
    "network",
    "connect",
    operation.networkId,
    "d".repeat(64),
  ]);
  assert.throws(() => readBootstrapWorkerDatabaseArguments(operation, "unsafe-name"));
});
