// Historical reconciliation is data, not a live mutation capability.
import { dirname, join } from "node:path";
import { canonical, digest, ensure, keys } from "../backup/schemas.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
function instant(v) {
  const n = Date.parse(v);
  ensure(typeof v === "string" && Number.isFinite(n) && new Date(n).toISOString() === v);
  return n;
}
function privateMetadata(v) {
  keys(v, ["dev", "ino", "uid", "gid", "mode", "size", "mtimeNs", "ctimeNs"]);
  for (const k of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
    ensure(typeof v[k] === "string" && /^[0-9]{1,30}$/u.test(v[k]));
  ensure(v.uid === process.getuid() && v.gid === process.getgid() && v.mode === 0o600);
}
export function validatePreservedForwardMetadata(original, archived) {
  privateMetadata(original);
  privateMetadata(archived);
  for (const k of Object.keys(original)) if (k !== "ctimeNs") same(original[k], archived[k]);
}
export function validateActivationReconciliation(records, raw, observation, prior, decision, now) {
  const id = prior.identity.operationId;
  const before = records.beforeObservation,
    after = records.afterObservation;
  for (const v of [before, after]) {
    keys(v, [
      "version",
      "kind",
      "operationId",
      "dispatch",
      "stateSha256",
      "schema",
      "workers",
      "containers",
      "observedAt",
      "lock",
      "probe",
    ]);
    ensure(
      v.version === 1 &&
        v.kind === "platform-forward-activation-reconciliation-observation" &&
        v.operationId === id &&
        v.stateSha256 === digest(raw.state),
    );
    same(v.dispatch, decision.dispatch);
    same(v.schema, prior.baseline.schema);
    same(v.workers, []);
    ensure(instant(v.observedAt) <= now && now - instant(v.observedAt) <= 3600000);
    keys(v.containers, ["postgres", "api", "edge"]);
    for (const service of ["postgres", "api", "edge"]) {
      const c = v.containers[service],
        retained = records.retainedRuntime.containers[service];
      keys(c, [
        "id",
        "imageId",
        "Running",
        "Paused",
        "Restarting",
        "Status",
        "Health",
        "StartedAt",
        "FinishedAt",
      ]);
      ensure(
        c.id === prior.baseline.containers[service] &&
          c.imageId === retained.Image &&
          c.Paused === false &&
          c.Restarting === false,
      );
      if (service === "postgres")
        ensure(c.Running === true && c.Status === "running" && c.Health?.Status === "healthy");
      else
        ensure(
          c.Running === false &&
            c.Status === "exited" &&
            Number.isFinite(Date.parse(c.StartedAt)) &&
            Number.isFinite(Date.parse(c.FinishedAt)) &&
            Date.parse(c.FinishedAt) <
              Number(BigInt(observation.activationMetadata.mtimeNs) / 1000000n),
        );
      for (const k of ["Running", "Paused", "Restarting", "Status", "StartedAt", "FinishedAt"])
        same(c[k], retained.State[k]);
    }
    keys(v.lock, ["present", "sha256", "metadata"]);
    keys(v.probe, ["present", "id", "inspectionSha256"]);
  }
  ensure(
    instant(before.observedAt) >= Date.parse(decision.expiresAt) &&
      instant(after.observedAt) >= instant(before.observedAt),
  );
  same(before.containers, after.containers);
  ensure(
    before.lock.present === true &&
      after.lock.present === false &&
      before.probe.present === true &&
      after.probe.present === false,
  );
  for (const k of ["sha256", "metadata"]) same(before.lock[k], after.lock[k]);
  for (const k of ["id", "inspectionSha256"]) same(before.probe[k], after.probe[k]);
  const li = records.lockIntent,
    ls = records.lockSuccess,
    pi = records.probeIntent,
    ps = records.probeSuccess;
  keys(li, [
    "version",
    "kind",
    "operationId",
    "dispatch",
    "stateSha256",
    "observationSha256",
    "lockSha256",
    "originalMetadata",
  ]);
  ensure(
    li.version === 1 &&
      li.kind === "platform-forward-activation-lock-preservation" &&
      li.operationId === id &&
      li.stateSha256 === digest(raw.state) &&
      li.observationSha256 === digest(raw.beforeObservation),
  );
  same(li.dispatch, decision.dispatch);
  keys(ls, [
    "version",
    "kind",
    "operationId",
    "intentSha256",
    "archivedSha256",
    "originalMetadata",
    "archivedMetadata",
  ]);
  ensure(
    ls.version === 1 &&
      ls.kind === "platform-forward-activation-lock-preservation-completed" &&
      ls.operationId === id &&
      ls.intentSha256 === digest(raw.lockIntent),
  );
  same(ls.originalMetadata, li.originalMetadata);
  same(li.originalMetadata, before.lock.metadata);
  same(ls.archivedMetadata, observation.archiveMetadata);
  validatePreservedForwardMetadata(ls.originalMetadata, ls.archivedMetadata);
  ensure(
    raw.archivedLock.length === 37 &&
      uuid(raw.archivedLock.toString("utf8").slice(0, -1)) &&
      raw.archivedLock.at(-1) === 10 &&
      digest(raw.archivedLock) === li.lockSha256 &&
      ls.archivedSha256 === li.lockSha256 &&
      before.lock.sha256 === li.lockSha256,
  );
  keys(pi, [
    "version",
    "kind",
    "operationId",
    "dispatch",
    "stateSha256",
    "observationSha256",
    "probeId",
    "inspectionSha256",
  ]);
  ensure(
    pi.version === 1 &&
      pi.kind === "platform-forward-activation-probe-cleanup" &&
      pi.operationId === id &&
      pi.stateSha256 === digest(raw.state) &&
      pi.observationSha256 === digest(raw.beforeObservation),
  );
  same(pi.dispatch, decision.dispatch);
  keys(ps, [
    "version",
    "kind",
    "operationId",
    "intentSha256",
    "probeId",
    "inspectionSha256",
    "observationSha256",
    "absent",
    "completedAt",
  ]);
  ensure(
    ps.version === 1 &&
      ps.kind === "platform-forward-activation-probe-cleanup-completed" &&
      ps.operationId === id &&
      ps.intentSha256 === digest(raw.probeIntent) &&
      ps.observationSha256 === digest(raw.afterObservation) &&
      ps.absent === true &&
      ps.completedAt === after.observedAt,
  );
  ensure(
    pi.inspectionSha256 === digest(raw.probeInspection) &&
      pi.inspectionSha256 === ps.inspectionSha256 &&
      pi.inspectionSha256 === before.probe.inspectionSha256 &&
      pi.probeId === ps.probeId &&
      pi.probeId === before.probe.id,
  );
  const probes = records.probeInspection;
  ensure(Array.isArray(probes) && probes.length === 1);
  const c = probes[0],
    selected = prior.identity.admission.registry.api,
    policy = records.activationOperation.observationPolicy;
  ensure(
    /^[a-f0-9]{64}$/u.test(c.Id) &&
      c.Id === pi.probeId &&
      c.Name === `/markiro-platform-probe-${id}` &&
      c.Image === selected.imageId &&
      c.Config.Image === selected.reference &&
      c.Config.Labels?.["io.markiro.probe-operation"] === id &&
      c.Config.User === `${process.getuid()}:${process.getgid()}`,
  );
  same(c.Config.Entrypoint, ["node"]);
  same(c.Config.Cmd, ["/probe/worker.mjs"]);
  ensure(
    c.State.Status === "exited" &&
      c.State.Running === false &&
      c.State.Paused === false &&
      c.State.Restarting === false &&
      c.State.ExitCode === 0 &&
      c.State.Pid === 0 &&
      Date.parse(c.State.StartedAt) <= Date.parse(c.State.FinishedAt) &&
      Date.parse(c.State.FinishedAt) <= Date.parse(decision.expiresAt),
  );
  ensure(
    c.HostConfig.ReadonlyRootfs === true &&
      c.HostConfig.Privileged === false &&
      c.HostConfig.NetworkMode === policy.networks.database.id,
  );
  same(c.HostConfig.CapDrop, ["ALL"]);
  same(c.HostConfig.CapAdd ?? [], []);
  same(c.HostConfig.SecurityOpt, ["no-new-privileges:true"]);
  same(c.HostConfig.PortBindings ?? {}, {});
  same(Object.keys(c.NetworkSettings.Networks), [policy.networks.database.name]);
  ensure(
    c.NetworkSettings.Networks[policy.networks.database.name].NetworkID ===
      policy.networks.database.id,
  );
  const mounts = c.Mounts;
  ensure(Array.isArray(mounts) && mounts.length === 3);
  same(mounts.map((m) => m.Destination).sort(), [
    "/input/ca.crt",
    "/input/connections.json",
    "/probe/worker.mjs",
  ]);
  const connections = mounts.find((m) => m.Destination === "/input/connections.json").Source;
  const prefix = `${observation.root}/probes/`;
  ensure(typeof connections === "string" && connections.startsWith(prefix));
  const relative = connections.slice(prefix.length).split("/");
  ensure(relative.length === 2 && uuid(relative[0]) && relative[1] === "connections.json");
  for (const m of mounts) {
    ensure(m.Type === "bind" && m.RW === false);
    same(
      m.Source,
      m.Destination === "/input/connections.json"
        ? connections
        : m.Destination === "/input/ca.crt"
          ? join(dirname(connections), "ca.crt")
          : `${dirname(observation.root)}/upgrade-bootstrap/${prior.identity.executorSha}/deploy/platform/host/probe-worker.mjs`,
    );
  }
}
