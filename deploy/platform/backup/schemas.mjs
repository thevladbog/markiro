import { createHash } from "node:crypto";
export const fail = (stage = "validation") => {
  const e = new Error("Protected database backup operation failed.");
  e.code = "ERR_DATABASE_BACKUP";
  e.stage = stage;
  return e;
};
export function ensure(ok) {
  if (!ok) throw fail();
}
export function plain(value, depth = 0) {
  ensure(depth < 30);
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    ensure(Number.isSafeInteger(value));
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => plain(v, depth + 1));
  ensure(value && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const out = {};
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    ensure(
      typeof key === "string" && key !== "__proto__" && d.enumerable && Object.hasOwn(d, "value"),
    );
    out[key] = plain(d.value, depth + 1);
  }
  return out;
}
export function keys(value, names) {
  ensure(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === names.length &&
      names.every((n) => Object.hasOwn(value, n)),
  );
}
export function canonical(value) {
  const v = plain(value);
  const order = (x) =>
    Array.isArray(x)
      ? x.map(order)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x)
              .sort()
              .map((k) => [k, order(x[k])]),
          )
        : x;
  return JSON.stringify(order(v));
}
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value))
    .digest("hex");
export const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
export const identifier = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 63 &&
  !/[\0\r\n]/u.test(value);
export const quote = (value) => {
  ensure(identifier(value));
  return '"' + value.replaceAll('"', '""') + '"';
};
export function identity(operationId, target) {
  ensure(
    typeof operationId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        operationId,
      ),
  );
  keys(target, ["hostId", "databaseId", "volumeId"]);
  for (const x of Object.values(target))
    ensure(typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(x));
}
export function bound(value, operationId, target) {
  identity(operationId, target);
  ensure(value.operationId === operationId && canonical(value.target) === canonical(target));
}
export function fence(value, operationId, target, boundary, { fresh = true } = {}) {
  const v = plain(value);
  keys(v, [
    "version",
    "kind",
    "operationId",
    "target",
    "fenceId",
    "enforcementSha256",
    "boundary",
    "beganAt",
    "observedAt",
    "held",
  ]);
  bound(v, operationId, target);
  ensure(
    v.version === 1 &&
      v.kind === "platform-writer-fence" &&
      v.boundary === boundary &&
      v.held === true &&
      hash(v.enforcementSha256) &&
      identifier(v.fenceId) &&
      typeof v.observedAt === "string" &&
      new Date(v.observedAt).toISOString() === v.observedAt,
  );
  ensure(
    typeof v.beganAt === "string" &&
      new Date(v.beganAt).toISOString() === v.beganAt &&
      Date.parse(v.beganAt) <= Date.parse(v.observedAt),
  );
  if (fresh) ensure(Math.abs(Date.now() - Date.parse(v.observedAt)) <= 30000);
  return v;
}
export function timestamp(value) {
  ensure(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
      new Date(value).toISOString() === value,
  );
  return Date.parse(value);
}
export function validateFencePair(value, operationId, target) {
  keys(value, ["before", "after"]);
  const before = fence(value.before, operationId, target, "before-snapshot", { fresh: false }),
    after = fence(value.after, operationId, target, "after-snapshot", { fresh: false });
  ensure(
    before.fenceId === after.fenceId &&
      before.beganAt === after.beganAt &&
      before.enforcementSha256 === after.enforcementSha256 &&
      timestamp(before.observedAt) <= timestamp(after.observedAt),
  );
  return value;
}
export function runtimeIdentity(value) {
  keys(value, ["image", "architecture", "postgresVersion"]);
  ensure(
    /^sha256:[a-f0-9]{64}$/u.test(value.image) &&
      ["amd64", "arm64"].includes(value.architecture) &&
      /^17\.[0-9]+(?: |$)/u.test(value.postgresVersion),
  );
}
export function connection(value, operationId, target) {
  const v = plain(value);
  keys(v, [
    "version",
    "kind",
    "operationId",
    "target",
    "service",
    "serviceFile",
    "passFile",
    "caFile",
    "network",
  ]);
  bound(v, operationId, target);
  ensure(
    v.version === 1 &&
      v.kind === "platform-backup-connection" &&
      v.service === "backup" &&
      /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(v.network),
  );
  for (const key of ["serviceFile", "passFile", "caFile"])
    ensure(typeof v[key] === "string" && v[key].startsWith("/"));
  return v;
}
export function runtime(value) {
  const v = plain(value);
  keys(v, ["version", "executorSha", "dockerExecutable", "endpoint", "image", "provenance"]);
  ensure(
    v.version === 1 &&
      /^[a-f0-9]{40}$/u.test(v.executorSha) &&
      v.dockerExecutable.startsWith("/") &&
      /^unix:\/\/\//u.test(v.endpoint) &&
      /^sha256:[a-f0-9]{64}$/u.test(v.image) &&
      ["local-synthetic", "live-source"].includes(v.provenance),
  );
  return v;
}
export const inventoryKeys = [
  "roles",
  "memberships",
  "objects",
  "defaultPrivileges",
  "extensions",
  "tables",
  "sequences",
  "indexes",
  "constraints",
  "migrationJournal",
];
export function validateInventory(value) {
  const v = plain(value);
  keys(v, inventoryKeys);
  for (const k of inventoryKeys) if (k !== "migrationJournal") ensure(Array.isArray(v[k]));
  ensure(
    v.migrationJournal === null ||
      (hash(v.migrationJournal.sha256) && /^\d+$/u.test(v.migrationJournal.count)),
  );
  for (const row of v.indexes)
    ensure(
      row.valid === true && row.ready === true && row.live === true && hash(row.definitionSha256),
    );
  for (const row of v.constraints)
    ensure(typeof row.validated === "boolean" && hash(row.definitionSha256));
  for (const row of v.tables) ensure(hash(row.sha256) && /^\d+$/u.test(row.count));
  for (const row of v.sequences)
    ensure(/^-?\d+$/u.test(row.lastValue) && typeof row.isCalled === "boolean");
  return v;
}
export function completedEvidence(value, expected) {
  const v = plain(value);
  keys(v, [
    "version",
    "kind",
    "status",
    "operationId",
    "target",
    "executorSha",
    "provenance",
    "archiveSha256",
    "inventorySha256",
    "roleMappingSha256",
    "restoredInventorySha256",
    "snapshotId",
    "fence",
    "startedAt",
    "completedAt",
    "runtime",
    "unvalidatedSourceConstraints",
    "checks",
    "cleanup",
  ]);
  bound(v, expected.operationId, expected.target);
  ensure(
    v.version === 1 &&
      v.kind === "platform-database-restore" &&
      v.status === "completed" &&
      v.archiveSha256 === expected.archiveSha256 &&
      v.inventorySha256 === expected.inventorySha256,
  );
  ensure(
    /^[a-f0-9]{40}$/u.test(v.executorSha) &&
      ["local-synthetic", "live-source"].includes(v.provenance) &&
      /^[A-F0-9-]+$/u.test(v.snapshotId),
  );
  if (expected.executorSha !== undefined) ensure(v.executorSha === expected.executorSha);
  if (expected.provenance !== undefined) ensure(v.provenance === expected.provenance);
  validateFencePair(v.fence, v.operationId, v.target);
  runtimeIdentity(v.runtime);
  ensure(
    timestamp(v.fence.after.observedAt) <= timestamp(v.startedAt) &&
      timestamp(v.startedAt) <= timestamp(v.completedAt) &&
      timestamp(v.completedAt) <= Date.now() + 30000,
  );
  keys(v.cleanup, ["verified", "resources"]);
  const resources = new Set();
  for (const r of v.cleanup.resources) {
    keys(r, ["kind", "name"]);
    ensure(
      ["volume", "container"].includes(r.kind) &&
        typeof r.name === "string" &&
        r.name.startsWith(`markiro-backup-${v.operationId}-restore-`) &&
        !resources.has(r.name),
    );
    resources.add(r.name);
  }
  for (const k of [
    "archiveSha256",
    "inventorySha256",
    "roleMappingSha256",
    "restoredInventorySha256",
  ])
    ensure(hash(v[k]));
  ensure(
    Number.isSafeInteger(v.unvalidatedSourceConstraints) && v.unvalidatedSourceConstraints >= 0,
  );
  ensure(
    v.cleanup.verified === true &&
      Array.isArray(v.cleanup.resources) &&
      v.cleanup.resources.length > 0 &&
      v.runtime.postgresVersion.startsWith("17.") &&
      /^sha256:[a-f0-9]{64}$/u.test(v.runtime.image),
  );
  ensure(
    canonical(v.checks) ===
      canonical([
        "archive",
        "inventory",
        "roles",
        "owners-acl-defaults",
        "extensions",
        "migration-journal",
        "table-bytes-counts",
        "sequences",
        "indexes-constraints",
        "cleanup",
      ]),
  );
  return v;
}
