import { randomUUID } from "node:crypto";
import { readFile, rm, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { canonical, digest, ensure, keys } from "../backup/schemas.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import {
  createPrivateDirectory,
  writePrivateFile,
  assertBindFileSync,
  assertPrivateFileSync,
  assertPrivateRootSync,
} from "./files.mjs";
import { guarded, observationError } from "./observe.mjs";

const adminQuery = `SELECT row_to_json(v) FROM (SELECT
 (SELECT system_identifier::text FROM pg_control_system()) AS system_id,
 current_setting('server_version') AS version,
 current_setting('ssl') AS ssl,
 current_setting('hba_file') AS hba_file,
 extract(epoch FROM pg_postmaster_start_time())*1000 AS started_at,
 (SELECT coalesce(json_agg(row_to_json(h) ORDER BY h.rule_number),'[]'::json) FROM (SELECT rule_number,type,database,user_name,address,netmask,auth_method,options,error FROM pg_hba_file_rules) h) AS hba,
 (SELECT coalesce(json_agg(row_to_json(s)),'[]'::json) FROM (SELECT usename,host(client_addr) AS client_addr,application_name FROM pg_stat_activity WHERE backend_type='client backend' AND datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()) s) AS sessions,
 (SELECT count(*)::int FROM pg_prepared_xacts WHERE database=current_database()) AS prepared
) v`;
const same = (a, b) => ensure(canonical(a) === canonical(b));

export async function observePostgresAdmin({ context, state, command, hbaSha256 }) {
  return guarded(async () => {
    const pg = state.owned.find((c) => c.service === "postgres").container;
    ensure(pg.State.Running && !pg.State.Restarting && !pg.State.Paused);
    const hostPath = pg.Mounts.find((m) => m.Destination === "/etc/postgresql/pg_hba.conf")?.Source;
    assertBindFileSync(hostPath);
    assertPrivateRootSync(dirname(hostPath));
    const metadata = await lstat(hostPath);
    ensure([0, process.getuid()].includes(metadata.uid) && (metadata.mode & 0o7777) === 0o644);
    const hba = await readFile(hostPath);
    ensure(digest(hba) === hbaSha256);
    const value = JSON.parse(
      (
        await command(
          [
            "exec",
            "--user",
            "70:70",
            "--env",
            "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000",
            "--env",
            "PGCONNECT_TIMEOUT=10",
            pg.Id,
            "psql",
            "-X",
            "--no-password",
            "--username",
            "postgres",
            "--dbname",
            "markiro",
            "--tuples-only",
            "--no-align",
            "--command",
            adminQuery,
          ],
          context.boundary === "recovery",
        )
      ).stdout,
    );
    ensure(
      value.system_id === context.identity.target.databaseId &&
        /^17\./u.test(value.version) &&
        value.ssl === "on" &&
        value.hba_file === "/etc/postgresql/pg_hba.conf" &&
        value.prepared === 0,
    );
    // pg_hba_file_rules describes current file bytes, not loaded rules. Require
    // this verified inode unchanged since postmaster startup; reload alone is
    // deliberately insufficient. Bootstrap must restart after policy installation.
    const after = await lstat(hostPath);
    for (const key of ["dev", "ino", "size", "mode", "uid", "mtimeMs", "ctimeMs"])
      ensure(metadata[key] === after[key]);
    ensure(Number(value.started_at) >= Math.max(after.mtimeMs, after.ctimeMs));
    same(value.hba, [
      {
        rule_number: 1,
        type: "local",
        database: ["all"],
        user_name: ["all"],
        address: null,
        netmask: null,
        auth_method: "peer",
        options: null,
        error: null,
      },
      {
        rule_number: 2,
        type: "hostnossl",
        database: ["all"],
        user_name: ["all"],
        address: "all",
        netmask: null,
        auth_method: "reject",
        options: null,
        error: null,
      },
      {
        rule_number: 3,
        type: "hostssl",
        database: ["all"],
        user_name: ["all"],
        address: "all",
        netmask: null,
        auth_method: "scram-sha-256",
        options: null,
        error: null,
      },
    ]);
    for (const session of value.sessions) {
      const service =
        session.usename === "markiro_app"
          ? "api"
          : session.usename === "markiro_migrator"
            ? "migrate"
            : null;
      ensure(
        service &&
          state.owned.some(
            (v) =>
              v.service === service &&
              v.active &&
              Object.values(v.container.NetworkSettings.Networks).some(
                (n) => n.IPAddress === session.client_addr,
              ),
          ),
      );
    }
    return value;
  });
}

export async function runPostgresProbe({
  context,
  policy,
  command,
  workerPath,
  verifySources,
  registerCleanup,
}) {
  let directory,
    created = false,
    terminated = true,
    problem,
    result,
    containerId,
    unregisterCleanup;
  const name = `markiro-platform-probe-${context.identity.operationId}`;
  const image = context.identity.admission.registry.api;
  const mounts = {};
  const uid = process.getuid(),
    gid = process.getgid();
  const executorUser = `${uid}:${gid}`;
  const existing = async (run = command) =>
    String((await run(["container", "ls", "--all", "--format", "{{.Names}}"], true)).stdout)
      .trim()
      .split("\n");
  const inspect = async (run = command) => {
    const values = JSON.parse((await run(["container", "inspect", name], true)).stdout);
    ensure(Array.isArray(values) && values.length === 1);
    const c = values[0];
    ensure(
      c.Name === `/${name}` &&
        /^[a-f0-9]{64}$/u.test(c.Id) &&
        c.Image === image.imageId &&
        c.Config.Image === image.reference &&
        c.Config.Labels?.["io.markiro.probe-operation"] === context.identity.operationId,
    );
    ensure(
      c.Config.User === executorUser &&
        c.HostConfig.ReadonlyRootfs &&
        !c.HostConfig.Privileged &&
        c.HostConfig.CapDrop?.includes("ALL") &&
        !c.HostConfig.CapAdd?.length &&
        c.HostConfig.SecurityOpt?.includes("no-new-privileges:true"),
    );
    same(c.Config.Entrypoint, ["node"]);
    same(c.Config.Cmd, ["/probe/worker.mjs"]);
    same(c.HostConfig.PortBindings ?? {}, {});
    same(Object.keys(c.NetworkSettings.Networks), [policy.networks.database.name]);
    ensure(c.HostConfig.NetworkMode === policy.networks.database.id);
    const networkId = c.NetworkSettings.Networks[policy.networks.database.name].NetworkID;
    // Docker allocates the endpoint only on start; the requested network is
    // already pinned in HostConfig. A started container must expose its ID.
    ensure(
      networkId === policy.networks.database.id ||
        (c.State.Status === "created" && !c.State.Running && networkId === ""),
    );
    same(c.Mounts.map((m) => m.Destination).sort(), Object.keys(mounts).sort());
    for (const m of c.Mounts)
      ensure(m.Type === "bind" && !m.RW && m.Source === mounts[m.Destination]);
    if (containerId) ensure(c.Id === containerId);
    else containerId = c.Id;
    return c;
  };
  // Trusted in-memory recovery registration. It carries this invocation's exact
  // recipe, private mounts and first observed ID, never a caller-selected name.
  const cleanup = async (run) => {
    ensure(created && terminated);
    if ((await existing(run)).includes(name)) {
      const c = await inspect(run);
      if (c.State.Running || c.State.Restarting || c.State.Paused)
        await run(["container", "stop", "--time", "10", c.Id], true);
      const stopped = await inspect(run);
      ensure(
        !stopped.State.Running &&
          !stopped.State.Restarting &&
          !stopped.State.Paused &&
          (stopped.State.Status === "exited" || stopped.State.Status === "created"),
      );
      await run(["container", "rm", c.Id], true);
    }
    ensure(!(await existing(run)).includes(name));
    unregisterCleanup?.();
  };
  try {
    ensure(Number.isSafeInteger(uid) && uid >= 0 && Number.isSafeInteger(gid) && gid >= 0);
    await verifySources();
    ensure(!(await existing()).includes(name));
    const root = context.root;
    await createPrivateDirectory(root, "probes", { exclusive: false });
    const key = randomUUID();
    await createPrivateDirectory(join(root, "probes"), key);
    directory = join(root, "probes", key);
    const runtime = await readProtectedEnv(context.configuration.runtimeSnapshot.path);
    const migration = await readProtectedEnv(context.configuration.migrationSnapshot.path);
    assertBindFileSync(runtime.MARKIRO_POSTGRES_CA_FILE);
    await writePrivateFile(
      directory,
      "connections.json",
      Buffer.from(
        JSON.stringify({ appUrl: runtime.DATABASE_URL, migrationUrl: migration.DATABASE_URL }),
      ),
    );
    await writePrivateFile(directory, "ca.crt", await readFile(runtime.MARKIRO_POSTGRES_CA_FILE));
    Object.assign(mounts, {
      "/input/connections.json": join(directory, "connections.json"),
      "/input/ca.crt": join(directory, "ca.crt"),
      "/probe/worker.mjs": workerPath,
    });
    // With all capabilities dropped, container root cannot read another UID's
    // private files. Bind only executor-owned 0600 inodes and use that trusted UID.
    for (const source of Object.values(mounts)) assertPrivateFileSync(source);
    // Mark intended ownership before create: a failed CLI may have reached Docker.
    unregisterCleanup = registerCleanup?.(cleanup);
    created = true;
    await command([
      "create",
      "--name",
      name,
      "--label",
      `io.markiro.probe-operation=${context.identity.operationId}`,
      "--network",
      policy.networks.database.id,
      "--user",
      executorUser,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--entrypoint",
      "node",
      ...Object.entries(mounts).flatMap(([destination, source]) => [
        "--mount",
        `type=bind,source=${source},target=${destination},readonly`,
      ]),
      image.reference,
      "/probe/worker.mjs",
    ]);
    await inspect();
    result = JSON.parse((await command(["start", "--attach", name])).stdout);
    const stopped = await inspect();
    ensure(
      stopped.State.Status === "exited" && stopped.State.ExitCode === 0 && !stopped.State.Running,
    );
    keys(result, ["postgresVersion", "tls"]);
    keys(result.tls, ["certificateSha256", "san", "notBefore", "expiresAt"]);
    await verifySources();
  } catch (error) {
    problem = error;
    terminated = error.terminationConfirmed !== false;
  }
  if (created && terminated) {
    try {
      await cleanup(command);
    } catch (error) {
      problem = error;
      terminated = error.terminationConfirmed !== false;
    }
  }
  // Preserve input for explicit reconciliation if any daemon/CLI state is uncertain.
  if (directory && terminated && !problem) await rm(directory, { recursive: true });
  if (problem) {
    const error = observationError(problem);
    if (!terminated) error.terminationConfirmed = false;
    throw error;
  }
  return result;
}
