import assert from "node:assert/strict";
import test from "node:test";

const policy = await import("../host/dadata-policy.mjs").catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  return {};
});
const token = "synthetic-private-token";
const secret = "synthetic-private-secret";
const oldEnv = { NODE_ENV: "production", DATABASE_URL: "synthetic-database" };
const candidateEnv = { ...oldEnv, DADATA_TOKEN: token };
const clone = (value) => structuredClone(value);
const hashes = { beforeConfigHash: "a".repeat(64), afterConfigHash: "b".repeat(64) };
function call(name, ...args) {
  assert.equal(typeof policy[name], "function", `${name} must enforce the DaData boundary`);
  return policy[name](...args);
}
function refused(action) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /synthetic|changed-password|leading/i);
    assert.equal(error.code, "ERR_DATABASE_BACKUP");
    return true;
  });
}
function compose(env = oldEnv) {
  return {
    name: "platform",
    services: {
      api: { image: "api@sha256:fixed", environment: clone(env), volumes: ["catalog:/catalog:ro"] },
      edge: { image: "edge@sha256:fixed", ports: ["443:443"] },
    },
    volumes: { catalog: { external: true } },
    networks: { platform: { external: true } },
  };
}
function inspect({ candidate = false } = {}) {
  const id = (candidate ? "b" : "a").repeat(64);
  return {
    Id: id,
    Created: candidate ? "2026-10-30T12:00:00Z" : "2026-10-29T12:00:00Z",
    Name: "/platform-api-1",
    Image: "sha256:" + "c".repeat(64),
    Path: "node",
    Args: ["dist/main.js"],
    State: {
      Status: "running",
      Running: true,
      Paused: false,
      Restarting: false,
      OOMKilled: false,
      Dead: false,
      Pid: candidate ? 20 : 10,
      ExitCode: 0,
      Error: "",
      StartedAt: candidate ? "2026-10-30T12:00:00Z" : "2026-10-29T12:00:00Z",
      FinishedAt: "0001-01-01T00:00:00Z",
      Health: { Status: "healthy", FailingStreak: 0, Log: [] },
    },
    Config: {
      Hostname: id.slice(0, 12),
      Domainname: "",
      User: "1000",
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      ExposedPorts: { "3000/tcp": {} },
      Tty: false,
      OpenStdin: false,
      StdinOnce: false,
      Env: Object.entries(candidate ? candidateEnv : oldEnv).map(
        ([key, value]) => `${key}=${value}`,
      ),
      Cmd: ["node", "dist/main.js"],
      Image: "api@sha256:fixed",
      Volumes: null,
      WorkingDir: "/app",
      Entrypoint: null,
      OnBuild: null,
      Labels: {
        "com.docker.compose.config-hash": candidate
          ? hashes.afterConfigHash
          : hashes.beforeConfigHash,
        "com.docker.compose.service": "api",
        "com.docker.compose.project": "platform",
      },
      Healthcheck: {
        Test: ["CMD", "node", "health.mjs"],
        Interval: 10000000000,
        Timeout: 5000000000,
        Retries: 3,
      },
    },
    HostConfig: {
      Binds: null,
      NetworkMode: "platform",
      PortBindings: {},
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      AutoRemove: false,
      Privileged: false,
      ReadonlyRootfs: true,
      CapAdd: null,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Mounts: [{ Type: "volume", Source: "catalog", Target: "/catalog", ReadOnly: true }],
      Memory: 1073741824,
      NanoCpus: 1000000000,
    },
    Mounts: [
      {
        Type: "volume",
        Name: "catalog",
        Source: "/var/lib/docker/volumes/catalog/_data",
        Destination: "/catalog",
        Driver: "local",
        Mode: "ro",
        RW: false,
        Propagation: "",
      },
    ],
    NetworkSettings: {
      Bridge: "",
      SandboxID: id,
      SandboxKey: `/var/run/docker/netns/${id.slice(0, 12)}`,
      Ports: { "3000/tcp": null },
      Networks: {
        platform: {
          IPAMConfig: null,
          Links: null,
          Aliases: ["platform-api-1", "api"],
          MacAddress: candidate ? "02:42:ac:11:00:03" : "02:42:ac:11:00:02",
          DriverOpts: null,
          NetworkID: "d".repeat(64),
          EndpointID: id,
          Gateway: "172.17.0.1",
          IPAddress: candidate ? "172.17.0.3" : "172.17.0.2",
          IPPrefixLen: 16,
          IPv6Gateway: "",
          GlobalIPv6Address: "",
          GlobalIPv6PrefixLen: 0,
          DNSNames: ["platform-api-1", "api", id.slice(0, 12)],
        },
      },
    },
  };
}

test("environment accepts only token or token-and-secret changes and returns frozen key names", () => {
  const changed = call("validateDadataDelta", oldEnv, candidateEnv);
  assert.deepEqual(changed, ["DADATA_TOKEN"]);
  assert.equal(Object.isFrozen(changed), true);
  assert.deepEqual(
    call("validateDadataDelta", oldEnv, { ...candidateEnv, DADATA_SECRET: secret }),
    ["DADATA_TOKEN", "DADATA_SECRET"],
  );
  assert.deepEqual(
    call("validateDadataDelta", candidateEnv, { ...candidateEnv, DADATA_SECRET: secret }),
    ["DADATA_SECRET"],
  );
});

test("environment refuses absent token, blank credentials, no-op and other environment changes", () => {
  for (const [before, after] of [
    [oldEnv, { ...oldEnv, DADATA_SECRET: secret }],
    [oldEnv, { ...candidateEnv, DADATA_TOKEN: "" }],
    [oldEnv, { ...candidateEnv, DADATA_TOKEN: " leading" }],
    [oldEnv, { ...candidateEnv, DADATA_SECRET: " " }],
    [candidateEnv, candidateEnv],
    [oldEnv, { ...candidateEnv, DATABASE_URL: "changed-password" }],
    [oldEnv, { DADATA_TOKEN: token, NODE_ENV: "production" }],
    [oldEnv, { ...candidateEnv, UNKNOWN: "value" }],
    [candidateEnv, oldEnv],
  ])
    refused(() => call("validateDadataDelta", before, after));
});

test("environment rejects malformed maps, hidden properties, accessors and control values without reading them", () => {
  const hidden = Object.defineProperty({ ...candidateEnv }, "HIDDEN", { value: secret });
  const accessor = Object.defineProperty({ ...candidateEnv }, "READ", {
    enumerable: true,
    get() {
      throw new Error(secret);
    },
  });
  const symbol = { ...candidateEnv, [Symbol("hidden")]: secret };
  for (const value of [
    null,
    [],
    "env",
    new Date(),
    hidden,
    accessor,
    symbol,
    { ...candidateEnv, DADATA_TOKEN: `${token}\n` },
    { ...candidateEnv, NODE_ENV: "production\u0000" },
    { ...candidateEnv, NODE_ENV: "production\u007f" },
    { ...candidateEnv, NODE_ENV: 4 },
    Object.create({ inherited: secret }),
  ])
    refused(() => call("validateDadataDelta", oldEnv, value));
});

test("rendered Compose accepts a DaData-only API delta without mutating input", () => {
  const before = compose(),
    after = compose(candidateEnv),
    saved = clone(after);
  assert.deepEqual(call("assertDadataComposeDelta", before, after), ["DADATA_TOKEN"]);
  assert.deepEqual(after, saved);
});

test("rendered Compose refuses any other service, image, mount, key or malformed map change", () => {
  for (const mutate of [
    (v) => {
      v.services.edge.image = "other";
    },
    (v) => {
      v.services.api.image = "other";
    },
    (v) => {
      v.services.api.volumes = ["catalog:/catalog:rw"];
    },
    (v) => {
      v.services.extra = { image: "other" };
    },
    (v) => {
      delete v.volumes;
    },
    (v) => {
      v.services.api.environment = ["DADATA_TOKEN=synthetic-private-token"];
    },
    (v) => {
      delete v.services.api;
    },
    (v) => {
      Object.defineProperty(v.services.edge, "hidden", { value: secret });
    },
  ]) {
    const after = compose(candidateEnv);
    mutate(after);
    refused(() => call("assertDadataComposeDelta", compose(), after));
  }
  refused(() => call("assertDadataComposeDelta", null, compose(candidateEnv)));
});

test("container accepts replacement with identical recipe and approved generated identity changes", () => {
  const before = inspect(),
    after = inspect({ candidate: true }),
    saved = clone(after);
  after.Config.Env.reverse();
  assert.deepEqual(call("assertDadataContainerDelta", before, after, hashes), ["DADATA_TOKEN"]);
  after.Config.Env.reverse();
  assert.deepEqual(after, saved);
});

test("container compares mount sets independently of inspect ordering", () => {
  const before = inspect(),
    after = inspect({ candidate: true });
  const other = { Type: "bind", Source: "/ca", Destination: "/etc/ca", RW: false };
  before.Mounts.push(other);
  after.Mounts.unshift(clone(other));
  assert.deepEqual(call("assertDadataContainerDelta", before, after, hashes), ["DADATA_TOKEN"]);
});

test("container refuses recipe, credential, mount, label, network and identity tampering", () => {
  for (const mutate of [
    (v) => {
      v.Name = "/other";
    },
    (v) => {
      v.Image = "sha256:" + "e".repeat(64);
    },
    (v) => {
      v.Config.Image = "different";
    },
    (v) => {
      v.Id = "a".repeat(64);
    },
    (v) => {
      v.Config.Hostname = "unexpected";
    },
    (v) => {
      v.Config.User = "root";
    },
    (v) => {
      v.Config.Cmd.push("--different");
    },
    (v) => {
      v.HostConfig.Privileged = true;
    },
    (v) => {
      v.HostConfig.ReadonlyRootfs = false;
    },
    (v) => {
      v.Mounts[0].RW = true;
    },
    (v) => {
      v.Mounts.push(clone(v.Mounts[0]));
    },
    (v) => {
      v.Config.Env.push("DATABASE_URL=changed-password");
    },
    (v) => {
      v.Config.Env.push("DADATA_TOKEN=duplicate");
    },
    (v) => {
      v.Config.Env.push("MALFORMED");
    },
    (v) => {
      v.Config.Labels["com.docker.compose.config-hash"] = "c".repeat(64);
    },
    (v) => {
      v.Config.Labels["com.docker.compose.project"] = "other";
    },
    (v) => {
      v.Config.Labels.EXTRA = "new";
    },
    (v) => {
      v.NetworkSettings.Networks.extra = clone(v.NetworkSettings.Networks.platform);
    },
    (v) => {
      v.NetworkSettings.Networks.platform.NetworkID = "e".repeat(64);
    },
    (v) => {
      v.NetworkSettings.Networks.platform.Aliases.push("extra");
    },
    (v) => {
      v.NetworkSettings.Networks.platform.Links = ["other:other"];
    },
    (v) => {
      v.NetworkSettings.Networks.platform.DriverOpts = { custom: "different" };
    },
    (v) => {
      v.NetworkSettings.Networks.platform.IPAMConfig = { IPv4Address: "172.17.0.4" };
    },
    (v) => {
      v.State.Health.Status = "unhealthy";
    },
    (v) => {
      v.State.Running = false;
    },
    (v) => {
      v.State.OOMKilled = true;
    },
    (v) => {
      v.State.Paused = true;
    },
    (v) => {
      v.State.Restarting = true;
    },
    (v) => {
      v.State.Dead = true;
    },
    (v) => {
      v.State.Status = "exited";
    },
    (v) => {
      delete v.HostConfig;
    },
    (v) => {
      v.Config = null;
    },
  ]) {
    const after = inspect({ candidate: true });
    mutate(after);
    refused(() => call("assertDadataContainerDelta", inspect(), after, hashes));
  }
  for (const options of [undefined, {}, { ...hashes, afterConfigHash: secret }])
    refused(() =>
      call("assertDadataContainerDelta", inspect(), inspect({ candidate: true }), options),
    );
  refused(() => call("assertDadataContainerDelta", null, inspect({ candidate: true }), hashes));
});

test("container refuses malformed old evidence and keeps all exception messages secret-free", () => {
  const before = inspect();
  before.Config.Env.push("DATABASE_URL=synthetic-private-secret");
  refused(() => call("assertDadataContainerDelta", before, inspect({ candidate: true }), hashes));
  const after = inspect({ candidate: true });
  Object.defineProperty(after.Config, "Hidden", {
    get() {
      throw new Error(secret);
    },
    enumerable: true,
  });
  refused(() => call("assertDadataContainerDelta", inspect(), after, hashes));
});

test("container treats host mount ordering as a set but rejects duplicate targets", () => {
  const before = inspect(),
    after = inspect({ candidate: true });
  const other = { Type: "bind", Source: "/ca", Target: "/etc/ca", ReadOnly: true };
  before.HostConfig.Mounts.push(other);
  after.HostConfig.Mounts.unshift(clone(other));
  assert.deepEqual(call("assertDadataContainerDelta", before, after, hashes), ["DADATA_TOKEN"]);
  after.HostConfig.Mounts.push(clone(other));
  refused(() => call("assertDadataContainerDelta", before, after, hashes));
});

test("descriptor validation never invokes environment or array getters", () => {
  let reads = 0;
  const afterEnv = { ...candidateEnv };
  Object.defineProperty(afterEnv, "EXTRA", {
    enumerable: true,
    get() {
      reads += 1;
      return secret;
    },
  });
  refused(() => call("validateDadataDelta", oldEnv, afterEnv));
  const after = inspect({ candidate: true });
  Object.defineProperty(after.Config.Env, "0", {
    enumerable: true,
    get() {
      reads += 1;
      return `DADATA_TOKEN=${secret}`;
    },
  });
  refused(() => call("assertDadataContainerDelta", inspect(), after, hashes));
  assert.equal(reads, 0);
});
