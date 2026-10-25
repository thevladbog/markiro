import { validateForwardAdmission } from "../host/forward-admission.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../backup/schemas.mjs";
import { forwardMigrationQuery } from "../host/forward-ledger.mjs";
import { preparedFixture } from "./prepared-target-fixture.mjs";
import { dockerFixture } from "./host-observe-fixture.mjs";
import { upgradeObservationFixture } from "./upgrade-observation-fixture.mjs";
import { forwardFixture } from "./forward-fixture.mjs";
import { forwardStateFixture } from "./forward-state-fixture.mjs";
export async function forwardObservationFixture(
  t,
  { targetBackup, operationId, suppliedDaemon } = {},
) {
  const prepared =
    suppliedDaemon?.f ?? targetBackup?.f ?? (await preparedFixture(t, { nested: true }));
  if (!targetBackup) prepared.identity.target.databaseId = "1234";
  const daemonFixture =
    suppliedDaemon ??
    (targetBackup
      ? {
          f: prepared,
          op: targetBackup.input.operation,
          policy: targetBackup.input.observationPolicy,
          state: targetBackup.daemon,
        }
      : await dockerFixture(t, { fixture: prepared }));
  const u = await upgradeObservationFixture(t, { daemonFixture });
  u.stop();
  u.d.state.containers[0].State.Health = { Status: "healthy" };
  const hba = await readFile(new URL("../postgres/pg_hba.conf", import.meta.url));
  const hbaPath = targetBackup?.input.hbaPath ?? join(u.root, "retained-hba.conf");
  if (!targetBackup) await writeFile(hbaPath, hba, { mode: 0o644 });
  u.d.state.containers[0].Mounts.find(
    (m) => m.Destination === "/etc/postgresql/pg_hba.conf",
  ).Source = hbaPath;
  const base = forwardFixture({
    root: u.root,
    operationId,
    upgrade: u,
    retainedIds: u.predecessorContainers,
    failedConfiguration: u.candidateOperation.configuration,
    candidateConfigurationSha256: u.candidateOperation.identity.configurationSha256,
  });
  const f = await forwardStateFixture(t, {}, { ...base, root: u.root });
  validateForwardAdmission(f.input, f);
  const admin = targetBackup?.daemon.adminResult ?? {
    system_id: "1234",
    version: "17.11",
    ssl: "on",
    hba_file: "/etc/postgresql/pg_hba.conf",
    started_at: Date.now() + 1000,
    sessions: [],
    prepared: 0,
    hba: [
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
    ],
  };
  const ledger = {
    schema: structuredClone(f.input.baseline.schema),
    rows: f.productMigrationProof.entries.map(({ hash, createdAt }) => ({ hash, createdAt })),
  };
  const dependencies = {
    ...u.dependencies,
    hbaSha256: digest(hba),
    verifySources: async () => {},
    runProcess: async (request) => {
      const sql = request.args.at(-1);
      if (typeof sql === "string" && sql.startsWith("SELECT row_to_json(v) FROM (SELECT\n"))
        return { stdout: Buffer.from(JSON.stringify(admin)) };
      if (sql === forwardMigrationQuery) return { stdout: Buffer.from(JSON.stringify(ledger)) };
      return u.dependencies.runProcess(request);
    },
  };
  const candidateOperation = { ...u.candidateOperation, identity: f.input.identity };
  return {
    ...f,
    u,
    admin,
    ledger,
    dependencies,
    oldOperation: u.oldOperation,
    candidateOperation,
    retainedIds: u.predecessorContainers,
    baseline: f.input.baseline,
    policy: u.policy,
  };
}
export function replaceForwardService(f, service) {
  const c = f.u.d.state.containers[service === "api" ? 1 : 2];
  c.Id = (service === "api" ? "6" : "7").repeat(64);
  c.State = {
    Running: true,
    Restarting: false,
    Paused: false,
    Status: "running",
    Health: { Status: "healthy" },
  };
  if (service === "api") {
    const extra = c.Config.Env.filter(
      (p) => !Object.hasOwn(f.u.oldEnv, p.slice(0, p.indexOf("="))),
    );
    c.Config.Env = [...Object.entries(f.u.candidateEnv).map(([k, v]) => `${k}=${v}`), ...extra];
  } else
    c.Config.Env.push(
      `MARKIRO_RELEASES_DOMAIN=${f.u.candidateEnv.MARKIRO_RELEASES_DOMAIN}`,
      `MARKIRO_RELEASES_BUCKET=${f.u.candidateEnv.MARKIRO_RELEASES_BUCKET}`,
    );
  return c;
}
