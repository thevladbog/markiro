/** Rehearsal-only isolation. Never imported by an installed host executor. */
import assert from "node:assert/strict";
import { canonical } from "./backup/schemas.mjs";
export const rehearsalLabel = "io.markiro.upgrade-rehearsal";
export const rehearsalImages = Object.freeze({
  daemon: "docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac",
  daemonId: "sha256:6a68f64cf32d98b09a11c208de78f59f17c0a6fff33c13f11acac853d6aad5ae",
  api: "ghcr.io/thevladbog/markiro-api@sha256:ef7549a646bb5f71a00459e9fca3303f154099711d528c3952daa83e06b1928a",
  edge: "ghcr.io/thevladbog/markiro-platform-edge@sha256:9008e368208eb78c43494ebc309464f2d1c59035ca7660d9bdfbe30b4c7a86c2",
});
export const rehearsalExecutor = "69f288e0a5299cabee229ce7dddf58bcba9fd22c";
export const rehearsalProduct = "0d30c7341bc9dfcabafaf60cb4a9b9173e56736d";
const same = (a, b) => assert.equal(canonical(a), canonical(b));
export function captureRehearsalResources({ invocationId, container, volume }) {
  assert.match(
    invocationId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  const name = `markiro-upgrade-ci-${invocationId}`;
  assert.equal(container.Name, `/${name}`);
  assert.match(container.Id, /^[a-f0-9]{64}$/u);
  assert.equal(container.Image, rehearsalImages.daemonId);
  assert.equal(container.Config.Labels[rehearsalLabel], invocationId);
  assert.equal(volume.Name, name);
  assert.equal(volume.Driver, "local");
  same(volume.Options ?? {}, {});
  assert.equal(volume.Labels[rehearsalLabel], invocationId);
  assert.equal(typeof volume.CreatedAt, "string");
  assert.ok(
    [
      `/var/lib/docker/volumes/${name}/_data`,
      `/var/lib/containers/storage/volumes/${name}/_data`,
    ].includes(volume.Mountpoint),
  );
  same(
    container.Mounts.map((m) => ({
      Type: m.Type,
      Name: m.Name,
      Source: m.Source,
      Destination: m.Destination,
      RW: m.RW,
    })),
    [
      {
        Type: "volume",
        Name: name,
        Source: volume.Mountpoint,
        Destination: "/var/lib/docker",
        RW: true,
      },
    ],
  );
  if (container.HostConfig.Binds?.length)
    same(container.HostConfig.Binds, [`${name}:/var/lib/docker:rw,rprivate,nosuid,nodev,rbind`]);
  assert.equal(container.HostConfig.Privileged, true);
  assert.ok(["", "private"].includes(container.HostConfig.PidMode));
  assert.ok(["private", "shareable"].includes(container.HostConfig.IpcMode));
  return Object.freeze({
    invocationId,
    id: container.Id,
    name,
    createdAt: volume.CreatedAt,
    mountpoint: volume.Mountpoint,
  });
}
export function validateRehearsalDaemon(observation, expected) {
  const actual = captureRehearsalResources(observation);
  if (expected) same(actual, expected);
  const { container, routes } = observation;
  assert.equal(container.HostConfig.NetworkMode, "bridge");
  assert.equal(container.State.Running, true);
  assert.equal(container.State.Paused, false);
  assert.equal(container.State.Restarting, false);
  same(container.NetworkSettings.Networks, {});
  same(container.HostConfig.PortBindings ?? {}, {});
  assert.ok(Object.values(container.NetworkSettings.Ports ?? {}).every((v) => v === null));
  assert.equal(routes.ipv4.trim(), "");
  assert.equal(routes.ipv6.trim(), "");
  return actual;
}
export function validateRehearsalEnvironment(value, generated, root) {
  same(value, generated);
  assert.match(root, /^\/(?:private\/)?tmp\/markiro-upgrade-ci-[a-zA-Z0-9_-]+$/u);
  for (const [key, v] of Object.entries(value)) {
    assert.equal(typeof v, "string");
    assert.ok(!/[\r\n\0]/u.test(v));
    if (key === "DATABASE_URL") {
      const u = new URL(v);
      assert.equal(u.hostname, "db.private");
      assert.equal(u.pathname, "/markiro");
      assert.equal(u.username, "markiro_app");
      assert.match(u.password, /^[a-f0-9]{64}$/u);
      assert.equal(u.searchParams.get("sslmode"), "verify-full");
    } else if (key.endsWith("_FILE")) assert.ok(v.startsWith(`${root}/`) && !v.includes("/../"));
    else if (key.endsWith("_DOMAIN")) assert.ok(v.endsWith(".localhost"));
    else if (key === "SMTP_HOST") assert.equal(v, "mail.invalid");
    else if (/_(?:URL|ORIGIN|ENDPOINT)$/u.test(key)) {
      const u = new URL(v);
      assert.ok(u.hostname.endsWith(".localhost") || u.hostname.endsWith(".invalid"));
    }
  }
}
export async function cleanupRehearsalResources(expected, io) {
  // Inspect both before removing either. Name alone never authorizes cleanup.
  const container = await io.inspectContainer(expected.id),
    volume = await io.inspectVolume(expected.name);
  same(
    captureRehearsalResources({ invocationId: expected.invocationId, container, volume }),
    expected,
  );
  await io.removeContainer(expected.id);
  const after = await io.inspectVolume(expected.name);
  same(
    {
      name: after.Name,
      createdAt: after.CreatedAt,
      mountpoint: after.Mountpoint,
      labels: after.Labels,
      options: after.Options ?? {},
      driver: after.Driver,
    },
    {
      name: volume.Name,
      createdAt: volume.CreatedAt,
      mountpoint: volume.Mountpoint,
      labels: volume.Labels,
      options: volume.Options ?? {},
      driver: volume.Driver,
    },
  );
  await io.removeVolume(expected.name);
}

export function rehearsalStagingNetwork(container) {
  assert.equal(container.HostConfig.NetworkMode, "bridge");
  const names = Object.keys(container.NetworkSettings.Networks);
  assert.equal(names.length, 1);
  assert.ok(["bridge", "podman"].includes(names[0]));
  assert.match(container.NetworkSettings.Networks[names[0]].NetworkID, /^[a-f0-9]{64}$/u);
  return names[0];
}
export function assertFreshRehearsalName(name, inventory) {
  assert.match(name, /^markiro-upgrade-ci-[a-f0-9-]{36}$/u);
  for (const key of ["containers", "volumes"]) {
    assert.ok(Array.isArray(inventory[key]));
    assert.ok(
      inventory[key].every(
        (n) =>
          typeof n === "string" &&
          !n
            .split(",")
            .map((s) => s.replace(/^\//u, ""))
            .includes(name),
      ),
    );
  }
}

export function validateRehearsalImage(daemon) {
  assert.equal(daemon.Id, rehearsalImages.daemonId);
  assert.equal(daemon.Architecture, "amd64");
  assert.equal(daemon.Os, "linux");
  assert.ok(
    ["docker", "docker.io/library/docker"].some((repository) =>
      daemon.RepoDigests.includes(rehearsalImages.daemon.replace("docker:28-dind", repository)),
    ),
  );
}

// Public failure evidence never includes command arguments, stderr, stack, env
// or generated credentials. A fixed executable/verb category locates the boundary.
export function rehearsalFailure(phase, error) {
  const command =
    /^(?:git (?:show|ls-files|rev-parse)|openssl (?:req|x509)|tar archive|docker (?:cp|exec|network|image|container|volume|pull|run|inspect|info|context))$/u.test(
      error.rehearsalCommand ?? "",
    )
      ? error.rehearsalCommand
      : null;
  const code = Number.isSafeInteger(error.code)
    ? `PROCESS_EXIT_${error.code}`
    : /^(?:ERR_[A-Z0-9_]+|E[A-Z0-9_]+)$/u.test(error.code ?? "")
      ? error.code
      : "REHEARSAL_FAILED";
  const name = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "AssertionError",
    "AbortError",
    "AggregateError",
  ]).has(error.name)
    ? error.name
    : "Error";
  const exitStatus = Number.isSafeInteger(error.code) && error.code >= 0 ? error.code : null;
  const executable = ["docker", "git", "openssl", "which", "tar"].includes(
    error.rehearsalExecutable,
  )
    ? error.rehearsalExecutable
    : null;
  // Reduce private stderr to a fixed category; never publish any matching text.
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const reasons = [
    [/\bopen \/tmp\/forward-worker\.tar: no such file or directory\b/iu, "worker-archive-missing"],
    [
      /\bopen \/var\/lib\/docker\/tmp\/docker-import-[^\r\n]*: no such file or directory\b/iu,
      "docker-import-file-missing",
    ],
    [
      /\b(?:open|stat|lstat) \/var\/lib\/docker\/[^\r\n]*: no such file or directory\b/iu,
      "docker-storage-file-missing",
    ],
    [/\bno such file or directory\b/iu, "missing-path"],
    [/\b(?:operation not permitted|permission denied)\b/iu, "permission-denied"],
    [/\bread-only file system\b/iu, "read-only-filesystem"],
    [/\b(?:no space left on device|disk quota exceeded)\b/iu, "capacity"],
    [/\boperation not supported\b/iu, "filesystem-not-supported"],
    [/\b(?:invalid tar header|invalid manifest|unrecognized image format)\b/iu, "invalid-archive"],
    [/\binvalid diffID for layer\b/iu, "layer-digest-mismatch"],
    [/\bunexpected EOF\b/iu, "unexpected-eof"],
    [/\bcannot connect to the Docker daemon\b/iu, "daemon-unavailable"],
    [/OCI runtime exec failed:/u, "container-exec"],
  ];
  const processReason =
    command === "docker exec"
      ? (reasons.find(([pattern]) => pattern.test(stderr))?.[1] ?? null)
      : null;
  return { phase, code, command, name, exitStatus, executable, processReason };
}
