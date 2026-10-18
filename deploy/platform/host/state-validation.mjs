import { canonicalId, exactKeys } from "../release-admission.mjs";
import { parseVerifiedImagesEvidence } from "../release-evidence.mjs";
import { parsePlatformManifest } from "../release-manifest.mjs";

export const phases = [
  "admitted",
  "images-verified",
  "target-stopped",
  "backup-verified",
  "migrating",
  "migrated",
  "api-started",
  "edge-started",
  "healthy",
];

export function stateError(durabilityUncertain = false) {
  const error = new Error("Host deployment state operation failed.");
  error.code = "ERR_HOST_STATE";
  error.durabilityUncertain = durabilityUncertain;
  return error;
}
const requireValid = (condition) => {
  if (!condition) throw stateError();
};
const matches = (value, pattern) => typeof value === "string" && pattern.exec(value)?.[0] === value;
const hash = (value) => matches(value, /^[a-f0-9]{64}$/u);
const sha = (value) => matches(value, /^[a-f0-9]{40}$/u);

// Reject getters, hidden/symbol keys, prototypes and toJSON before cloning or
// serializing caller input. All records here contain only JSON objects/scalars.
export function snapshot(value, depth = 0) {
  requireValid(depth < 20);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    requireValid(Number.isSafeInteger(value));
    return value;
  }
  requireValid(
    typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)),
  );
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValid(
      typeof key === "string" &&
        key !== "__proto__" &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, "value"),
    );
    result[key] = snapshot(descriptor.value, depth + 1);
  }
  return result;
}

export function sameTarget(a, b) {
  return ["hostId", "databaseId", "volumeId"].every((key) => a[key] === b[key]);
}
function target(value) {
  requireValid(exactKeys(value, ["hostId", "databaseId", "volumeId"]));
  for (const item of Object.values(value))
    requireValid(matches(item, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u));
}

function admission(value) {
  requireValid(
    exactKeys(value, [
      "version",
      "kind",
      "repository",
      "manifest",
      "verified",
      "artifact",
      "publisher",
      "ci",
      "registry",
    ]),
  );
  requireValid(
    value.version === 1 &&
      value.kind === "platform-release-admission" &&
      value.repository === "thevladbog/markiro",
  );
  const { manifest, verified, publisher, ci, artifact, registry } = value;
  requireValid(
    exactKeys(publisher, ["runId", "runAttempt"]) && exactKeys(ci, ["runId", "runAttempt"]),
  );
  for (const id of [publisher.runId, publisher.runAttempt, ci.runId, ci.runAttempt])
    requireValid(canonicalId(id));
  requireValid(
    exactKeys(artifact, ["id", "sha256"]) && canonicalId(artifact.id) && hash(artifact.sha256),
  );
  parsePlatformManifest(JSON.stringify(manifest), publisher.runId);
  parseVerifiedImagesEvidence(JSON.stringify(verified), {
    sourceSha: manifest.sourceSha,
    toolingSha: manifest.toolingSha,
    workflowRunId: publisher.runId,
    workflowRunAttempt: publisher.runAttempt,
    ciRunId: ci.runId,
    ciRunAttempt: ci.runAttempt,
  });
  requireValid(exactKeys(registry, ["api", "edge"]));
  for (const name of ["api", "edge"]) {
    const image = registry[name];
    requireValid(exactKeys(image, ["reference", "imageId", "platform"]));
    requireValid(
      image.reference === manifest[name] &&
        image.imageId === verified.images[name].id &&
        image.platform === "linux/amd64",
    );
  }
}

export function validateIdentity(value) {
  requireValid(
    exactKeys(value, ["operationId", "admission", "executorSha", "configurationSha256", "target"]),
  );
  requireValid(
    matches(
      value.operationId,
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    ),
  );
  requireValid(sha(value.executorSha) && hash(value.configurationSha256));
  target(value.target);
  admission(value.admission);
  return value;
}
export function validateBackup(value, identity) {
  requireValid(
    exactKeys(value, ["archiveSha256", "restoreEvidenceSha256", "target", "operationId"]),
  );
  requireValid(hash(value.archiveSha256) && hash(value.restoreEvidenceSha256));
  target(value.target);
  requireValid(
    value.operationId === identity.operationId && sameTarget(value.target, identity.target),
  );
  return value;
}
function current(value) {
  requireValid(exactKeys(value, ["identity", "phase", "status", "backup"]));
  validateIdentity(value.identity);
  const index = phases.indexOf(value.phase);
  requireValid(index >= 0 && ["entered", "completed", "recovery-required"].includes(value.status));
  if (value.backup !== null) validateBackup(value.backup, value.identity);
  if (index < 3 || (index === 3 && value.status === "entered")) requireValid(value.backup === null);
  if (index > 3 || (index === 3 && value.status === "completed"))
    requireValid(value.backup !== null);
}

export function validateState(value) {
  requireValid(exactKeys(value, ["version", "sequence", "current", "previousHealthy"]));
  requireValid(value.version === 1 && Number.isSafeInteger(value.sequence) && value.sequence >= 0);
  if (value.current === null) {
    requireValid(value.sequence === 0 && value.previousHealthy === null);
    return value;
  }
  current(value.current);
  let offset = 0;
  if (value.previousHealthy !== null) {
    current(value.previousHealthy);
    requireValid(
      value.previousHealthy.phase === "healthy" && value.previousHealthy.status === "completed",
    );
    requireValid(
      value.current.identity.operationId !== value.previousHealthy.identity.operationId &&
        sameTarget(value.current.identity.target, value.previousHealthy.identity.target),
    );
    // Every earlier operation had exactly 18 durable phase mutations. Failed
    // operations are terminal; there is deliberately no recovery/reset API.
    requireValid(value.sequence >= 19);
    offset = Math.floor((value.sequence - 1) / 18) * 18;
  }
  const entered = 1 + 2 * phases.indexOf(value.current.phase);
  const sequence = value.sequence - offset;
  if (value.current.status === "recovery-required") {
    requireValid(
      sequence === entered + 1 || (value.current.phase !== "healthy" && sequence === entered + 2),
    );
    if (value.current.phase === "backup-verified")
      requireValid((value.current.backup === null) === (sequence === entered + 1));
  } else requireValid(sequence === entered + (value.current.status === "completed" ? 1 : 0));
  return value;
}
