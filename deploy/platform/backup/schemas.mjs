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
  "triggers",
  "migrationJournal",
];
export const objectKinds = new Set([
  "DATABASE",
  "SCHEMA",
  "TABLE",
  "VIEW",
  "MATERIALIZED VIEW",
  "SEQUENCE",
  "FUNCTION",
  "PROCEDURE",
  "TYPE",
  "DOMAIN",
  "OPERATOR",
  "OPERATOR CLASS",
  "OPERATOR FAMILY",
]);
export const privileges = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
  "USAGE",
  "CREATE",
  "CONNECT",
  "TEMPORARY",
  "EXECUTE",
]);
const roleNameValid = (value) => identifier(value) && value !== "PUBLIC";
function uniqueRows(rows, identity, validate) {
  ensure(Array.isArray(rows));
  const seen = new Set();
  for (const row of rows) {
    validate(row);
    const id = canonical(identity(row));
    ensure(!seen.has(id));
    seen.add(id);
  }
}
function acl(value, allowed) {
  uniqueRows(
    value,
    (a) => [a.grantor, a.grantee, a.privilege],
    (a) => {
      keys(a, ["grantor", "grantee", "privilege", "grantable"]);
      ensure(
        roleNameValid(a.grantor) &&
          (a.grantee === "PUBLIC" || roleNameValid(a.grantee)) &&
          allowed.has(a.privilege) &&
          typeof a.grantable === "boolean" &&
          !(a.grantee === "PUBLIC" && a.grantable),
      );
    },
  );
}
const aclPrivileges = {
  DATABASE: new Set(["CREATE", "CONNECT", "TEMPORARY"]),
  SCHEMA: new Set(["CREATE", "USAGE"]),
  TABLE: new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ]),
  SEQUENCE: new Set(["SELECT", "UPDATE", "USAGE"]),
  FUNCTION: new Set(["EXECUTE"]),
  TYPE: new Set(["USAGE"]),
  OPERATOR: new Set(),
};
const objectPrivilegeKind = (kind) =>
  ({
    VIEW: "TABLE",
    "MATERIALIZED VIEW": "TABLE",
    PROCEDURE: "FUNCTION",
    DOMAIN: "TYPE",
    "OPERATOR CLASS": "OPERATOR",
    "OPERATOR FAMILY": "OPERATOR",
  })[kind] ?? kind;
function objectRow(o) {
  ensure(objectKinds.has(o.kind));
  const routine = ["FUNCTION", "PROCEDURE"].includes(o.kind),
    method = ["OPERATOR CLASS", "OPERATOR FAMILY"].includes(o.kind);
  keys(o, [
    "kind",
    "schema",
    "name",
    "owner",
    "acl",
    "extension",
    "args",
    ...(routine ? ["definitionSha256"] : []),
    ...(method ? ["method"] : []),
    ...(o.kind === "DATABASE" ? ["locale"] : []),
  ]);
  ensure(
    identifier(o.name) &&
      roleNameValid(o.owner) &&
      (o.extension === null || o.extension === "btree_gist") &&
      (["DATABASE", "SCHEMA"].includes(o.kind) ? o.schema === "" : identifier(o.schema)),
  );
  ensure(Array.isArray(o.args));
  if (!routine && o.kind !== "OPERATOR") ensure(o.args.length === 0);
  if (o.kind === "OPERATOR")
    ensure(
      o.args.length === 2 &&
        /^[+*<>=~!@#%^&|`?/-]+$/u.test(o.name) &&
        !o.name.includes("--") &&
        !o.name.includes("/*"),
    );
  for (const arg of o.args) {
    keys(arg, ["schema", "name"]);
    ensure(
      (o.kind === "OPERATOR" && arg.schema === null && arg.name === null) ||
        (identifier(arg.schema) && identifier(arg.name)),
    );
  }
  if (method) ensure(identifier(o.method));
  if (routine) ensure(hash(o.definitionSha256));
  if (o.kind === "DATABASE") {
    keys(o.locale, ["encoding", "collate", "ctype", "provider"]);
    ensure(
      o.locale.provider === "c" &&
        [o.locale.encoding, o.locale.collate, o.locale.ctype].every(
          (x) => typeof x === "string" && /^[A-Za-z0-9_.@-]+$/u.test(x),
        ),
    );
  }
  acl(o.acl, aclPrivileges[objectPrivilegeKind(o.kind)]);
}
function objectKey(o) {
  const group = ["TABLE", "VIEW", "MATERIALIZED VIEW", "SEQUENCE"].includes(o.kind)
    ? "relation"
    : ["FUNCTION", "PROCEDURE"].includes(o.kind)
      ? "routine"
      : ["TYPE", "DOMAIN"].includes(o.kind)
        ? "type"
        : o.kind;
  return [group, o.schema, o.name, o.args, o.method ?? null];
}
const unsigned = (value) => typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value);
const qualified = (row) => ensure(identifier(row.schema) && identifier(row.name));
export function validateInventory(value) {
  const v = plain(value);
  keys(v, inventoryKeys);
  uniqueRows(
    v.roles,
    (r) => r.name,
    (r) => {
      keys(r, [
        "name",
        "login",
        "superuser",
        "createdb",
        "createrole",
        "replication",
        "bypassrls",
        "inherit",
        "connectionLimit",
      ]);
      ensure(roleNameValid(r.name));
      for (const k of [
        "login",
        "superuser",
        "createdb",
        "createrole",
        "replication",
        "bypassrls",
        "inherit",
      ])
        ensure(typeof r[k] === "boolean");
      ensure(
        Number.isInteger(r.connectionLimit) &&
          r.connectionLimit >= -1 &&
          r.connectionLimit <= 2147483647,
      );
    },
  );
  uniqueRows(
    v.memberships,
    (m) => [m.role, m.member, m.grantor],
    (m) => {
      keys(m, ["role", "member", "grantor", "admin", "inherit", "set"]);
      for (const k of ["role", "member", "grantor"]) ensure(roleNameValid(m[k]));
      for (const k of ["admin", "inherit", "set"]) ensure(typeof m[k] === "boolean");
    },
  );
  uniqueRows(v.objects, objectKey, objectRow);
  uniqueRows(
    v.defaultPrivileges,
    (d) => [d.owner, d.schema, d.kind],
    (d) => {
      keys(d, ["owner", "schema", "kind", "acl"]);
      const kind = { r: "TABLE", S: "SEQUENCE", f: "FUNCTION", T: "TYPE", n: "SCHEMA" }[d.kind];
      ensure(roleNameValid(d.owner) && (d.schema === "" || identifier(d.schema)) && kind);
      acl(d.acl, aclPrivileges[kind]);
      ensure(d.acl.every((a) => a.grantor === d.owner));
    },
  );
  uniqueRows(
    v.extensions,
    (e) => e.name,
    (e) => {
      keys(e, ["name", "version", "schema", "owner"]);
      ensure(
        e.name === "btree_gist" &&
          typeof e.version === "string" &&
          /^[0-9]+(?:\.[0-9]+)*$/u.test(e.version) &&
          identifier(e.schema) &&
          roleNameValid(e.owner),
      );
    },
  );
  uniqueRows(
    v.tables,
    (r) => [r.schema, r.name],
    (r) => {
      keys(r, ["schema", "name", "count", "sha256"]);
      qualified(r);
      ensure(unsigned(r.count) && hash(r.sha256));
    },
  );
  uniqueRows(
    v.sequences,
    (r) => [r.schema, r.name],
    (r) => {
      keys(r, ["schema", "name", "lastValue", "isCalled"]);
      qualified(r);
      ensure(
        typeof r.lastValue === "string" &&
          /^-?(0|[1-9][0-9]*)$/u.test(r.lastValue) &&
          typeof r.isCalled === "boolean",
      );
    },
  );
  uniqueRows(
    v.indexes,
    (r) => [r.schema, r.name],
    (r) => {
      keys(r, ["schema", "name", "definitionSha256", "valid", "ready", "live"]);
      qualified(r);
      ensure(hash(r.definitionSha256) && r.valid === true && r.ready === true && r.live === true);
    },
  );
  uniqueRows(
    v.constraints,
    (r) => [r.schema, r.table, r.name],
    (r) => {
      keys(r, ["schema", "table", "name", "definitionSha256", "validated"]);
      qualified(r);
      ensure(
        (r.table === "" || identifier(r.table)) &&
          hash(r.definitionSha256) &&
          typeof r.validated === "boolean",
      );
    },
  );
  uniqueRows(
    v.triggers,
    (r) => [r.schema, r.table, r.name],
    (r) => {
      keys(r, ["schema", "table", "name", "definitionSha256", "enabled"]);
      qualified(r);
      ensure(
        identifier(r.table) && hash(r.definitionSha256) && ["O", "D", "R", "A"].includes(r.enabled),
      );
    },
  );
  if (v.migrationJournal !== null) {
    keys(v.migrationJournal, ["count", "sha256"]);
    ensure(unsigned(v.migrationJournal.count) && hash(v.migrationJournal.sha256));
  }
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
