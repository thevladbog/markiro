import { carryHostFailure } from "../host/failure-diagnostic.mjs";
import { join, dirname, relative } from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import { assertPrivateRootSync, readPrivateFile } from "../host/files.mjs";
import { ensure, runtime, fail, digest } from "./schemas.mjs";
import { withHeldHostState } from "../host/state.mjs";
import { withHeldUpgradeState } from "../host/upgrade-state.mjs";
const recoveryRuntimes = new WeakMap();

// This factory cannot be supplied an arbitrary predecessor or phase. It consumes
// the live upgrade guard and binds independently provisioned bytes for this op.
export function withUpgradeBackupRuntime(capability, action) {
  return withHeldUpgradeState(capability, async (held) => {
    const { root, state } = held;
    ensure(
      state.phase === "backup-verified" &&
        state.status === "entered" &&
        state.oldRuntime &&
        !state.migrationEntered &&
        typeof action === "function",
    );
    const admission = state.admission;
    const original = await readPrivateFile(root, "backup-runtime.json");
    const originalState = JSON.parse(await readPrivateFile(root, "state.json"));
    ensure(
      runtime(JSON.parse(original)).executorSha === originalState.current.identity.executorSha,
    );
    const priorName = `recovery-backup-runtime-${admission.predecessor.identity.operationId}.json`;
    const priorBytes = await readPrivateFile(root, priorName);
    ensure(
      runtime(JSON.parse(priorBytes)).executorSha === admission.predecessor.identity.executorSha,
    );
    const name = `upgrade-backup-runtime-${admission.identity.operationId}.json`;
    const bytes = await readPrivateFile(root, name);
    const config = runtime(JSON.parse(bytes));
    ensure(
      config.executorSha === admission.identity.executorSha &&
        config.provenance === "live-source" &&
        config.dockerExecutable === "/usr/bin/docker" &&
        config.endpoint === "unix:///var/run/docker.sock",
    );
    await held.verify();
    const context = Object.freeze({});
    recoveryRuntimes.set(context, {
      root,
      operationId: admission.identity.operationId,
      name,
      bytes,
      original,
      priorName,
      priorBytes,
      verify: held.verify,
    });
    try {
      return await action(held, context);
    } finally {
      recoveryRuntimes.delete(context);
    }
  });
}
export function withRecoveryBackupRuntime(capability, action) {
  return withHeldHostState(capability, async (held) => {
    const issued = [];
    try {
      return await action(held, async (admission) => {
        const context = await createRecoveryBackupRuntime(held.root, admission);
        issued.push(context);
        return context;
      });
    } finally {
      for (const context of issued) recoveryRuntimes.delete(context);
    }
  });
}
// Admission and the held producer read the same independently provisioned
// descriptor. Neither changes its executor/image provenance. The opaque runtime
// context below can be issued only while consuming the held-state capability.
export async function validateRecoveryBackupRuntime(root, admission) {
  const { identity, predecessor } = admission;
  const original = await readPrivateFile(root, "backup-runtime.json");
  const previous = runtime(JSON.parse(original));
  ensure(previous.executorSha === predecessor.identity.executorSha);
  const name = `recovery-backup-runtime-${identity.operationId}.json`;
  const bytes = await readPrivateFile(root, name);
  const config = runtime(JSON.parse(bytes));
  ensure(config.executorSha === identity.executorSha && config.provenance === "live-source");
  ensure(
    config.dockerExecutable === "/usr/bin/docker" &&
      config.endpoint === "unix:///var/run/docker.sock",
  );
  return { root, operationId: identity.operationId, name, bytes, original };
}
async function createRecoveryBackupRuntime(root, admission) {
  const bound = await validateRecoveryBackupRuntime(root, admission);
  const context = Object.freeze({});
  recoveryRuntimes.set(context, bound);
  return context;
}
export async function readBackupRuntime(root, operationId, recoveryRuntime) {
  if (recoveryRuntime === undefined) return readPrivateFile(root, "backup-runtime.json");
  const bound = recoveryRuntimes.get(recoveryRuntime);
  ensure(bound && bound.root === root && bound.operationId === operationId);
  if (bound.verify) await bound.verify();
  if (bound.retained)
    for (const [path, before] of bound.retained)
      ensure((await readPrivateFile(root, path)).equals(before));
  if (bound.priorName)
    ensure((await readPrivateFile(root, bound.priorName)).equals(bound.priorBytes));
  ensure((await readPrivateFile(root, "backup-runtime.json")).equals(bound.original));
  const bytes = await readPrivateFile(root, bound.name);
  ensure(bytes.equals(bound.bytes));
  return bytes;
}
export async function openRuntime({ root, operationId, purpose, run, recoveryRuntime }) {
  assertPrivateRootSync(root);
  ensure(["archive", "restore"].includes(purpose));
  const config = runtime(JSON.parse(await readBackupRuntime(root, operationId, recoveryRuntime)));
  const dockerConfig = join(root, "docker");
  await mkdir(dockerConfig, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  assertPrivateRootSync(dockerConfig);
  const command = async (args) => {
    try {
      if (recoveryRuntime !== undefined)
        await readBackupRuntime(root, operationId, recoveryRuntime);
      return await run({
        executable: config.dockerExecutable,
        args: ["--host", config.endpoint, ...args],
        cwd: root,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DOCKER_CONFIG: dockerConfig },
        timeoutMs: 900000,
        outputLimitBytes: 1048576,
      });
    } catch (error) {
      const action = args[0] === "exec" ? args[2] : args[0];
      throw carryHostFailure(error, fail(`docker-${action}-${error.reason ?? "failed"}`));
    }
  };
  const label = "markiro.backup-operation",
    prefix = `markiro-backup-${operationId}-${purpose}`;
  const volume = `${prefix}-data`,
    inputVolume = `${prefix}-input`,
    init = `${prefix}-init`,
    container = `${prefix}-worker`;
  const owned = [];
  const image = JSON.parse((await command(["image", "inspect", config.image])).stdout)[0];
  ensure(image.Id === config.image && image.Os === "linux");
  const architecture = image.Architecture;
  ensure(
    Object.keys(image.Config.Volumes ?? {})
      .sort()
      .join() === "/var/lib/postgresql/data",
  );
  const remove = async (kind, name) => {
    const existing = String(
      (
        await command([
          kind,
          "ls",
          ...(kind === "container" ? ["--all"] : []),
          "--filter",
          `label=${label}=${operationId}`,
          "--format",
          kind === "container" ? "{{.Names}}" : "{{.Name}}",
        ])
      ).stdout,
    )
      .trim()
      .split("\n");
    if (!existing.includes(name)) {
      // A missing ownership label is not proof of absence. Inspect the full names.
      const all = String(
        (
          await command([
            kind,
            "ls",
            ...(kind === "container" ? ["--all"] : []),
            "--format",
            kind === "container" ? "{{.Names}}" : "{{.Name}}",
          ])
        ).stdout,
      )
        .trim()
        .split("\n");
      ensure(!all.includes(name));
      return;
    }
    const value = JSON.parse((await command([kind, "inspect", name])).stdout)[0];
    ensure((value.Config?.Labels ?? value.Labels)?.[label] === operationId);
    await command([kind, "rm", ...(kind === "container" ? ["--force"] : []), name]);
    const all = String(
      (
        await command([
          kind,
          "ls",
          ...(kind === "container" ? ["--all"] : []),
          "--format",
          kind === "container" ? "{{.Names}}" : "{{.Name}}",
        ])
      ).stdout,
    )
      .trim()
      .split("\n");
    ensure(!all.includes(name));
  };
  return {
    config,
    architecture,
    container,
    command,
    async prepare(input, network) {
      assertPrivateRootSync(input);
      ensure(network === "none" || /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(network));
      if (network !== "none") {
        const n = JSON.parse((await command(["network", "inspect", network])).stdout)[0];
        ensure(n.Internal === true);
      }
      const existingVolumes = String(
        (await command(["volume", "ls", "--format", "{{.Name}}"])).stdout,
      )
        .trim()
        .split("\n");
      ensure(!existingVolumes.includes(volume) && !existingVolumes.includes(inputVolume));
      owned.push(["volume", volume]);
      await command(["volume", "create", "--label", `${label}=${operationId}`, volume]);
      owned.push(["volume", inputVolume]);
      await command(["volume", "create", "--label", `${label}=${operationId}`, inputVolume]);
      owned.push(["container", init]);
      await command([
        "create",
        "--name",
        init,
        "--label",
        `${label}=${operationId}`,
        "--network",
        "none",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "DAC_OVERRIDE",
        "--security-opt",
        "no-new-privileges:true",
        "--read-only",
        "--mount",
        `type=volume,source=${volume},target=/var/lib/postgresql/data`,
        "--mount",
        `type=volume,source=${volume},target=/work`,
        "--mount",
        `type=volume,source=${inputVolume},target=/input`,
        config.image,
        "sleep",
        "infinity",
      ]);
      await command(["start", init]);
      await command(["cp", `${input}/.`, `${init}:/input/`]);
      await command(["exec", init, "chmod", "700", "/work", "/input"]);
      await command(["exec", init, "chown", "-R", "999:999", "/work", "/input"]);
      await remove("container", init);
      owned.push(["container", container]);
      await command([
        "create",
        "--name",
        container,
        "--label",
        `${label}=${operationId}`,
        "--network",
        network,
        "--user",
        "999:999",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--read-only",
        "--mount",
        `type=volume,source=${volume},target=/var/lib/postgresql/data`,
        "--mount",
        `type=volume,source=${volume},target=/work`,
        "--mount",
        `type=volume,source=${inputVolume},target=/input,readonly`,
        config.image,
        ...(purpose === "archive"
          ? ["node", "/opt/backup/backup/postgres-worker.mjs", purpose]
          : ["sleep", "infinity"]),
      ]);
      const c = JSON.parse((await command(["inspect", container])).stdout)[0];
      for (const [check, ok] of Object.entries({
        network:
          network === "none"
            ? c.HostConfig.NetworkMode === "none" &&
              Object.keys(c.NetworkSettings.Networks ?? {}).every((name) => name === "none")
            : Object.keys(c.NetworkSettings.Networks ?? {}).join() === network,
        ports: Object.keys(c.HostConfig.PortBindings ?? {}).length === 0,
        user: c.Config.User === "999:999",
        readonly: c.HostConfig.ReadonlyRootfs === true,
        mounts:
          c.Mounts.length === 3 &&
          c.Mounts.every((m) => {
            const expected = {
              "/work": { name: volume, writable: true },
              "/var/lib/postgresql/data": { name: volume, writable: true },
              "/input": { name: inputVolume, writable: false },
            }[m.Destination];
            return (
              expected &&
              m.Type === "volume" &&
              m.Name === expected.name &&
              m.RW === expected.writable
            );
          }) &&
          new Set(c.Mounts.map((m) => m.Destination)).size === 3,
        input: c.Mounts.find((m) => m.Name === inputVolume)?.RW === false,
      })) {
        if (!ok) throw fail(`container-${check}`);
      }
    },
    async execute() {
      try {
        if (purpose === "archive") {
          await command(["start", "--attach", container]);
          const state = JSON.parse(
            (await command(["inspect", "--format", "{{json .State}}", container])).stdout,
          );
          ensure(state.Status === "exited" && state.ExitCode === 0);
          return;
        }
        await command(["start", container]);
        await command([
          "exec",
          container,
          "node",
          "/opt/backup/backup/postgres-worker.mjs",
          "restore-init",
        ]);
        // PostgreSQL is daemon-owned, not a descendant that can escape the bounded
        // runner. Its entire container is independently inspected and removed.
        await command([
          "exec",
          "--detach",
          container,
          "/usr/lib/postgresql/17/bin/postgres",
          "-D",
          "/work/pgdata",
          "-c",
          "listen_addresses=",
          "-c",
          "unix_socket_directories=/work/socket",
        ]);
        let ready = false;
        for (let i = 0; i < 60; i++) {
          try {
            await command([
              "exec",
              container,
              "/usr/lib/postgresql/17/bin/pg_isready",
              "-h",
              "/work/socket",
              "-U",
              "restore_admin",
            ]);
            ready = true;
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 250));
          }
        }
        ensure(ready);
        await command([
          "exec",
          container,
          "node",
          "/opt/backup/backup/postgres-worker.mjs",
          "restore",
        ]);
      } catch (error) {
        let stage = "worker";
        try {
          await command([
            "cp",
            `${container}:/work/out/failure.json`,
            join(root, `${prefix}-failure.json`),
          ]);
          const result = JSON.parse(await readPrivateFile(root, `${prefix}-failure.json`));
          if (/^[a-z0-9-]{1,100}$/u.test(result.stage) && /^[A-Z0-9_]+$/u.test(result.code))
            stage = `${result.stage}-${result.code}`;
        } catch {
          /* Missing worker diagnostics still fail closed. */
        }
        try {
          await command([
            "cp",
            `${container}:/work/out/restored.json`,
            join(root, `${prefix}-restored.json`),
          ]);
        } catch {
          /* Only successful capture produces comparison diagnostics. */
        }
        throw carryHostFailure(error, fail(stage));
      }
    },
    async output(destination) {
      assertPrivateRootSync(destination);
      await command(["cp", `${container}:/work/out/.`, destination]);
    },
    async cleanup() {
      let ok = true;
      for (const [kind, name] of [...owned].reverse()) {
        try {
          await remove(kind, name);
        } catch {
          ok = false;
        }
      }
      const result = { verified: ok, resources: owned.map(([kind, name]) => ({ kind, name })) };
      if (!ok) {
        const error = fail("cleanup");
        error.cleanup = result;
        throw error;
      }
      return result;
    },
  };
}
export async function readPrivateAbsolute(root, path, options) {
  const name = relative(root, path);
  ensure(name && !name.startsWith(".") && !name.startsWith("/"));
  return readPrivateFile(root, name, options);
}
export async function privateCopy(root, path, destination) {
  const bytes = await readPrivateAbsolute(root, path);
  const { writeFile } = await import("node:fs/promises");
  assertPrivateRootSync(dirname(destination));
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  await chmod(destination, 0o600);
}

// Separate post-migration capability. Dynamic import keeps historical installed
// ordinary/recovery closures unchanged until the new forward factory is used.
export async function withForwardBackupRuntime(capability, action) {
  const { withHeldForwardState, validateForwardSourceRuntime } =
    await import("../host/forward-state.mjs");
  return withHeldForwardState(capability, async (held) => {
    const { root, state } = held,
      admission = state.admission;
    ensure(
      held.cleanup === false &&
        !state.decision &&
        state.migrationEntered === true &&
        state.phase === "backup-verified" &&
        state.sequence === 5 &&
        state.status === "entered" &&
        typeof action === "function",
    );
    validateForwardSourceRuntime(state.sourceRuntime, admission);
    const originalState = JSON.parse(await readPrivateFile(root, "state.json"));
    const preceding = [];
    let lineage = admission;
    if (admission.kind === "platform-forward-edge-successor") {
      const bytes = await readPrivateFile(
        root,
        `forward-recovery-operations/${admission.priorEdge.identity.operationId}/state.json`,
      );
      ensure(digest(bytes) === admission.priorEdge.hashes.state);
      lineage = JSON.parse(bytes).admission;
      ensure(lineage.kind === "platform-forward-activation-successor");
    }
    if (lineage.kind === "platform-forward-admission-successor")
      preceding.push(lineage.priorForward);
    if (lineage.kind === "platform-forward-activation-successor") {
      const parentBytes = await readPrivateFile(
        root,
        `forward-recovery-operations/${lineage.priorActivation.identity.operationId}/state.json`,
      );
      ensure(digest(parentBytes) === lineage.priorActivation.hashes.state);
      const parent = JSON.parse(parentBytes).admission;
      ensure(parent.kind === "platform-forward-admission-successor");
      preceding.push(parent.priorForward, lineage.priorActivation);
    }
    if (admission.kind === "platform-forward-edge-successor") preceding.push(admission.priorEdge);
    const descriptors = [
      ["backup-runtime.json", originalState.current.identity.executorSha],
      [
        `recovery-backup-runtime-${admission.originalPredecessor.identity.operationId}.json`,
        admission.originalPredecessor.identity.executorSha,
      ],
      [
        `upgrade-backup-runtime-${admission.failed.identity.operationId}.json`,
        admission.failed.identity.executorSha,
      ],
      ...preceding.map((prior) => [
        `forward-backup-runtime-${prior.identity.operationId}.json`,
        prior.identity.executorSha,
      ]),
    ];
    const retained = [];
    for (const [name, executorSha] of descriptors) {
      const bytes = await readPrivateFile(root, name);
      const config = runtime(JSON.parse(bytes));
      ensure(
        config.executorSha === executorSha &&
          config.provenance === "live-source" &&
          config.dockerExecutable === "/usr/bin/docker" &&
          config.endpoint === "unix:///var/run/docker.sock",
      );
      retained.push([name, bytes]);
    }
    const name = `forward-backup-runtime-${admission.identity.operationId}.json`;
    const bytes = await readPrivateFile(root, name),
      config = runtime(JSON.parse(bytes));
    ensure(
      config.executorSha === admission.identity.executorSha &&
        config.provenance === "live-source" &&
        config.dockerExecutable === "/usr/bin/docker" &&
        config.endpoint === "unix:///var/run/docker.sock",
    );
    const verify = async () => {
      await held.verify();
      for (const [path, before] of retained)
        ensure((await readPrivateFile(root, path)).equals(before));
      ensure((await readPrivateFile(root, name)).equals(bytes));
    };
    await verify();
    const context = Object.freeze({});
    recoveryRuntimes.set(context, {
      root,
      operationId: admission.identity.operationId,
      name,
      bytes,
      original: retained[0][1],
      retained,
      verify,
    });
    try {
      const result = await action(held, context);
      await verify();
      return result;
    } finally {
      recoveryRuntimes.delete(context);
    }
  });
}
