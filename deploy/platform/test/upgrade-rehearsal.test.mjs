import assert from "node:assert/strict";
import test from "node:test";
import {
  rehearsalLabel,
  rehearsalStagingNetwork,
  assertFreshRehearsalName,
  rehearsalImages,
  validateRehearsalDaemon,
  validateRehearsalEnvironment,
  captureRehearsalResources,
  cleanupRehearsalResources,
} from "../upgrade-ci-guards.mjs";
const invocationId = "12345678-1234-4234-8234-123456789012";
const name = `markiro-upgrade-ci-${invocationId}`;
function fixture() {
  const volume = {
    Name: name,
    Driver: "local",
    Options: {},
    Labels: { [rehearsalLabel]: invocationId },
    CreatedAt: "2026-10-24T00:00:00Z",
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`,
  };
  const container = {
    Id: "a".repeat(64),
    Name: `/${name}`,
    Image: rehearsalImages.daemonId,
    Config: { Labels: { [rehearsalLabel]: invocationId } },
    State: { Running: true, Paused: false, Restarting: false },
    HostConfig: {
      Privileged: true,
      Binds: null,
      PortBindings: {},
      NetworkMode: "bridge",
      PidMode: "",
      IpcMode: "private",
    },
    Mounts: [
      {
        Type: "volume",
        Name: name,
        Source: volume.Mountpoint,
        Destination: "/var/lib/docker",
        RW: true,
      },
    ],
    NetworkSettings: { Networks: {}, Ports: {} },
  };
  return { invocationId, container, volume, routes: { ipv4: "", ipv6: "" } };
}
test("rehearsal daemon requires exact owned isolated namespace before any application launch", () => {
  assert.doesNotThrow(() => validateRehearsalDaemon(fixture()));
});
for (const mutation of [
  "network",
  "route4",
  "route6",
  "host socket",
  "foreign volume",
  "foreign owner",
  "foreign image",
  "published port",
  "host pid",
  "recreated",
])
  test(`rehearsal rejects ${mutation} before launch`, () => {
    const f = fixture();
    const expected = captureRehearsalResources(f);
    if (mutation === "network")
      f.container.NetworkSettings.Networks.bridge = { NetworkID: "b".repeat(64) };
    if (mutation === "route4") f.routes.ipv4 = "default via 172.17.0.1 dev eth0";
    if (mutation === "route6") f.routes.ipv6 = "default via fe80::1 dev eth0";
    if (mutation === "host socket")
      f.container.Mounts.push({
        Type: "bind",
        Source: "/var/run/docker.sock",
        Destination: "/var/run/docker.sock",
        RW: true,
      });
    if (mutation === "foreign volume") f.container.Mounts[0].Name = "shared";
    if (mutation === "foreign owner") f.volume.Labels[rehearsalLabel] = "different";
    if (mutation === "foreign image") f.container.Image = "sha256:" + "f".repeat(64);
    if (mutation === "published port")
      f.container.HostConfig.PortBindings = { "2375/tcp": [{ HostPort: "2375" }] };
    if (mutation === "host pid") f.container.HostConfig.PidMode = "host";
    if (mutation === "recreated") f.container.Id = "b".repeat(64);
    assert.throws(() => validateRehearsalDaemon(f, expected));
  });
const generated = {
  DATABASE_URL:
    "postgresql://markiro_app:" + "a".repeat(64) + "@db.private/markiro?sslmode=verify-full",
  S3_ENDPOINT: "https://storage.invalid",
  SMTP_HOST: "mail.invalid",
  PLATFORM_AUTH_URL: "https://saas-admin.localhost",
  PLATFORM_AUTH_SECRET: "b".repeat(64),
  MARKIRO_POSTGRES_CA_FILE: "/private/tmp/markiro-upgrade-ci-example/state/pg/ca.crt",
};
test("only generated private fixture environment can enter the rehearsal", () => {
  assert.doesNotThrow(() =>
    validateRehearsalEnvironment(generated, generated, "/private/tmp/markiro-upgrade-ci-example"),
  );
  for (const [key, value] of [
    ["DATABASE_URL", "postgresql://prod:secret@201.34.136.19/markiro"],
    ["S3_ENDPOINT", "https://s3.timeweb.cloud"],
    ["PLATFORM_AUTH_SECRET", "copied-production-secret"],
    ["MARKIRO_POSTGRES_CA_FILE", "/opt/markiro-platform/ca.crt"],
  ])
    assert.throws(() =>
      validateRehearsalEnvironment(
        { ...generated, [key]: value },
        generated,
        "/private/tmp/markiro-upgrade-ci-example",
      ),
    );
});
test("cleanup rechecks exact resources and never removes a replacement/shared volume", async () => {
  const f = fixture(),
    expected = captureRehearsalResources(f),
    trace = [];
  await cleanupRehearsalResources(expected, {
    inspectContainer: async () => f.container,
    inspectVolume: async () => f.volume,
    removeContainer: async (id) => trace.push(id),
    removeVolume: async (n) => trace.push(n),
  });
  assert.deepEqual(trace, [f.container.Id, f.volume.Name]);
  for (const which of ["container", "volume"]) {
    const bad = structuredClone(f);
    if (which === "container") bad.container.Id = "b".repeat(64);
    else bad.volume.CreatedAt = "2026-10-24T01:00:00Z";
    const removed = [];
    await assert.rejects(
      cleanupRehearsalResources(expected, {
        inspectContainer: async () => bad.container,
        inspectVolume: async () => bad.volume,
        removeContainer: async (id) => removed.push(id),
        removeVolume: async (n) => removed.push(n),
      }),
    );
    assert.deepEqual(removed, []);
  }
});
test("local Podman volume and private PID namespace remain exact-owned without host binds", () => {
  const f = fixture();
  f.volume.Mountpoint = `/var/lib/containers/storage/volumes/${f.volume.Name}/_data`;
  f.container.Mounts[0].Source = f.volume.Mountpoint;
  f.container.HostConfig.PidMode = "private";
  f.container.HostConfig.IpcMode = "shareable";
  f.container.HostConfig.Binds = [
    `${f.volume.Name}:/var/lib/docker:rw,rprivate,nosuid,nodev,rbind`,
  ];
  assert.doesNotThrow(() => validateRehearsalDaemon(f));
  const expected = captureRehearsalResources(f);
  f.volume.Mountpoint = "/var/lib/containers/storage/volumes/shared/_data";
  f.container.Mounts[0].Source = f.volume.Mountpoint;
  assert.throws(() => validateRehearsalDaemon(f, expected));
});

test("only one known staging bridge is detached and reused names are refused", () => {
  for (const network of ["bridge", "podman"]) {
    const c = fixture().container;
    c.NetworkSettings.Networks = { [network]: { NetworkID: "b".repeat(64) } };
    assert.equal(rehearsalStagingNetwork(c), network);
  }
  for (const network of ["host", "none", "shared"]) {
    const c = fixture().container;
    c.NetworkSettings.Networks = { [network]: { NetworkID: "b".repeat(64) } };
    assert.throws(() => rehearsalStagingNetwork(c));
  }
  assert.doesNotThrow(() =>
    assertFreshRehearsalName(name, { containers: ["other"], volumes: ["shared"] }),
  );
  for (const key of ["containers", "volumes"])
    assert.throws(() =>
      assertFreshRehearsalName(name, { containers: [], volumes: [], [key]: [name] }),
    );
});
