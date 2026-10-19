import { join, dirname, relative } from "node:path";
import { chmod, mkdir } from "node:fs/promises";
import { assertPrivateRootSync, readPrivateFile } from "../host/files.mjs";
import { ensure, runtime, fail } from "./schemas.mjs";
export async function openRuntime({ root, operationId, purpose, run }) {
  assertPrivateRootSync(root);
  ensure(["archive", "restore"].includes(purpose));
  const config = runtime(JSON.parse(await readPrivateFile(root, "backup-runtime.json")));
  const dockerConfig = join(root, "docker");
  await mkdir(dockerConfig, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  assertPrivateRootSync(dockerConfig);
  const command = async (args) => {
    try {
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
      throw fail(`docker-${action}-${error.reason ?? "failed"}`);
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
      } catch {
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
        throw fail(stage);
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
export async function readPrivateAbsolute(root, path) {
  const name = relative(root, path);
  ensure(name && !name.startsWith(".") && !name.startsWith("/"));
  return readPrivateFile(root, name);
}
export async function privateCopy(root, path, destination) {
  const bytes = await readPrivateAbsolute(root, path);
  const { writeFile } = await import("node:fs/promises");
  assertPrivateRootSync(dirname(destination));
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  await chmod(destination, 0o600);
}
