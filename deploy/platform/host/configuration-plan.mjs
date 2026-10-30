import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { canonical, ensure, keys } from "../backup/schemas.mjs";
const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const id = (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/u.test(v);
const path = (v) =>
  typeof v === "string" &&
  isAbsolute(v) &&
  normalize(v) === v &&
  !/[\s\0]/u.test(v) &&
  !v.endsWith("/");
const child = (root, v) => path(v) && v.startsWith(`${root}/`);
const guardPath = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/u.test(v) &&
  v.split("/").every((p) => p && p !== "." && p !== "..");
export function validateConfigurationContainer(v) {
  keys(v, ["id", "imageId", "recipeSha256"]);
  ensure(hash(v.id) && hash(v.recipeSha256) && /^sha256:[a-f0-9]{64}$/u.test(v.imageId));
  return v;
}
export function validateConfigurationRuntime(v) {
  keys(v, ["path", "sha256"]);
  ensure(path(v.path) && hash(v.sha256));
  return v;
}
export function validateConfigurationBaseline(v) {
  canonical(v);
  keys(v, ["acceptedOperationId", "api", "runtime"]);
  ensure(uuid(v.acceptedOperationId));
  validateConfigurationContainer(v.api);
  validateConfigurationRuntime(v.runtime);
  return v;
}
/** Metadata only. Actual private bytes, live CI/review and host are verified separately. */
export function validateConfigurationPlan(v) {
  try {
    canonical(v);
    keys(v, [
      "version",
      "kind",
      "operationId",
      "acceptedOperationId",
      "executorSha",
      "executorCi",
      "previousOperationId",
      "previousReceiptSha256",
      "before",
      "runtime",
      "containers",
      "workers",
      "compose",
      "guards",
      "schemaProof",
    ]);
    ensure(
      v.version === 1 &&
        v.kind === "platform-dadata-configuration" &&
        uuid(v.operationId) &&
        uuid(v.acceptedOperationId) &&
        v.operationId !== v.acceptedOperationId &&
        /^[a-f0-9]{40}$/u.test(v.executorSha),
    );
    keys(v.executorCi, ["runId", "runAttempt"]);
    ensure(id(v.executorCi.runId) && v.executorCi.runAttempt === "1");
    ensure(
      (v.previousOperationId === null && v.previousReceiptSha256 === null) ||
        (uuid(v.previousOperationId) &&
          v.previousOperationId !== v.operationId &&
          hash(v.previousReceiptSha256)),
    );
    validateConfigurationBaseline(v.before);
    ensure(v.before.acceptedOperationId === v.acceptedOperationId);
    validateConfigurationRuntime(v.runtime);
    const suffix = `/configuration-operations/${v.operationId}/runtime.env`;
    ensure(v.runtime.path.endsWith(suffix));
    const stateRoot = v.runtime.path.slice(0, -suffix.length),
      hostRoot = dirname(stateRoot);
    ensure(
      stateRoot.endsWith("/state") &&
        child(stateRoot, v.before.runtime.path) &&
        v.runtime.path !== v.before.runtime.path &&
        v.runtime.sha256 !== v.before.runtime.sha256,
    );
    keys(v.containers, ["edge", "postgres"]);
    const containers = [v.before.api, ...Object.values(v.containers), ...v.workers];
    ensure(Array.isArray(v.workers) && v.workers.length <= 29);
    containers.forEach(validateConfigurationContainer);
    ensure(new Set(containers.map((c) => c.id)).size === containers.length);
    keys(v.compose, ["files", "directory", "migrationPath", "beforeConfigHash", "afterConfigHash"]);
    ensure(
      child(hostRoot, v.compose.directory) &&
        v.compose.directory.endsWith("/deploy/platform") &&
        Array.isArray(v.compose.files),
    );
    const expectedFiles = ["compose.yml", "compose.compact.yml", "compose.catalog.yml"].map(
      (name) => join(v.compose.directory, name),
    );
    ensure(
      [2, 3].includes(v.compose.files.length) &&
        v.compose.files.every((file, i) => file === expectedFiles[i]),
    );
    ensure(
      child(stateRoot, v.compose.migrationPath) &&
        v.compose.migrationPath.endsWith("/migration.env") &&
        hash(v.compose.beforeConfigHash) &&
        hash(v.compose.afterConfigHash) &&
        v.compose.beforeConfigHash !== v.compose.afterConfigHash,
    );
    ensure(Array.isArray(v.guards) && v.guards.length >= 4 && v.guards.length <= 1000);
    for (const guard of v.guards) {
      keys(guard, ["path", "sha256"]);
      ensure(guardPath(guard.path) && hash(guard.sha256));
    }
    const guards = new Map(v.guards.map((g) => [g.path, g.sha256]));
    ensure(guards.size === v.guards.length);
    for (const name of [
      "state/state.json",
      "state/upgrade-index.json",
      `state/forward-recovery-operations/${v.acceptedOperationId}/state.json`,
    ])
      ensure(guards.has(name));
    ensure(guards.get(relative(hostRoot, v.before.runtime.path)) === v.before.runtime.sha256);
    keys(v.schemaProof, ["systemId", "migrationCount", "schemaSha256", "migrationSha256"]);
    ensure(
      id(v.schemaProof.systemId) &&
        id(v.schemaProof.migrationCount) &&
        hash(v.schemaProof.schemaSha256) &&
        hash(v.schemaProof.migrationSha256),
    );
    return v;
  } catch {
    const error = new Error("Protected configuration plan rejected.");
    error.code = "ERR_CONFIGURATION_PLAN";
    throw error;
  }
}
