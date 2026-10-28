// Trusted caller entrypoint. Phase implementations are evaluated only after the
// entire separate recovery installation has passed exact-byte verification.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, lstat } from "node:fs/promises";
import { canonical, digest, ensure, keys } from "../backup/schemas.mjs";
import { assertPrivateRootSync, assertBindFileSync, readPrivateFile } from "./files.mjs";
export const RECOVERY_BUNDLE_FILES = Object.freeze([
  "deploy/platform/host/failure-diagnostic.mjs",
  "deploy/platform/host/upgrade-state.mjs",
  "deploy/platform/host/upgrade-admission.mjs",
  "deploy/platform/host/upgrade-phase-admission.mjs",
  "deploy/platform/host/upgrade-proofs.mjs",
  "deploy/platform/recovery-transport.mjs",
  "deploy/platform/admit-release.mjs",
  "deploy/platform/admission-process.mjs",
  "deploy/platform/admission-archive.mjs",
  "deploy/platform/admission-registry.mjs",
  "deploy/platform/host/command.mjs",
  "deploy/platform/host/observe.mjs",
  "deploy/platform/host/probe.mjs",
  "deploy/platform/host/probe-worker.mjs",
  "deploy/platform/host/deploy.mjs",
  "deploy/platform/host/deployment-boundary.mjs",
  "deploy/platform/host/config.mjs",
  "deploy/platform/host/files.mjs",
  "deploy/platform/host/process.mjs",
  "deploy/platform/host/prepared-target.mjs",
  "deploy/platform/host/operation-authority.mjs",
  "deploy/platform/host/backup-gate.mjs",
  "deploy/platform/host/state.mjs",
  "deploy/platform/host/state-validation.mjs",
  "deploy/platform/backup/schemas.mjs",
  "deploy/platform/backup/locale.mjs",
  "deploy/platform/backup/files.mjs",
  "deploy/platform/backup/restore.mjs",
  "deploy/platform/backup/local-runtime.mjs",
  "deploy/platform/backup/inventory.mjs",
  "deploy/platform/backup/definitions.mjs",
  "deploy/platform/backup/catalog.mjs",
  "deploy/platform/postgres/roles.mjs",
  "deploy/platform/postgres/pg_hba.conf",
  "deploy/platform/compose.yml",
  "deploy/platform/compose.compact.yml",
  "deploy/platform/compose.catalog.yml",
  "deploy/platform/preflight.mjs",
  "deploy/platform/catalog-config.mjs",
  "deploy/platform/release-manifest.mjs",
  "deploy/platform/release-evidence.mjs",
  "deploy/platform/release-admission.mjs",
  "deploy/platform/release-ci.mjs",
  "deploy/platform/admission-github.mjs",
  "deploy/platform/host/admission-read-failure.mjs",
  "deploy/platform/admission-archive.py",
  "deploy/production/release-manifest.mjs",
  "deploy/production/cli-main.mjs",
  "deploy/platform/host/recovery-command.mjs",
  "deploy/platform/host/recovery-command-runtime.mjs",
  "deploy/platform/host/recovery-admission.mjs",
  "deploy/platform/host/recovery-state.mjs",
  "deploy/platform/host/recovery-preparation.mjs",
  "deploy/platform/host/recovery-activation.mjs",
  "deploy/platform/host/recovery-activation-admission.mjs",
  "deploy/platform/host/recovery-activation-state.mjs",
  "deploy/platform/host/target-backup.mjs",
  "deploy/platform/backup/archive.mjs",
  "deploy/platform/backup/postgres-worker.mjs",
  "deploy/platform/backup/source-state.mjs",
]);

const same = (a, b) => ensure(canonical(a) === canonical(b));
const loads = new WeakSet();
function failure(error, phase) {
  const result = new Error("Platform recovery host command failed.");
  result.code = "ERR_HOST_RECOVERY_COMMAND";
  result.phase = phase ?? null;
  result.recoveryRequired = true;
  result.durabilityUncertain = error?.durabilityUncertain === true;
  if (error?.terminationConfirmed === false) result.terminationConfirmed = false;
  return result;
}
function dispatch(value) {
  keys(value, ["toolingSha", "runId", "runAttempt"]);
  ensure(typeof value.toolingSha === "string" && /^[a-f0-9]{40}$/u.test(value.toolingSha));
  ci({ runId: value.runId, runAttempt: value.runAttempt });
}
function ci(value) {
  keys(value, ["runId", "runAttempt"]);
  for (const v of Object.values(value))
    ensure(typeof v === "string" && /^[1-9][0-9]*$/u.test(v) && Number.isSafeInteger(Number(v)));
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export async function loadRecoveryOperation(directory, options = {}) {
  try {
    assertPrivateRootSync(directory);
    const operationBytes = await readPrivateFile(directory, "operation.json");
    const record = JSON.parse(operationBytes);
    keys(record, [
      "version",
      "kind",
      "phase",
      "installedRoot",
      "dispatch",
      "operation",
      "observationPolicy",
    ]);
    ensure(
      record.version === 1 &&
        record.kind === "platform-recovery-host-operation" &&
        ["prepare", "activate"].includes(record.phase),
    );
    dispatch(record.dispatch);
    const op = record.operation;
    keys(
      op,
      record.phase === "prepare"
        ? ["root", "admission", "configuration", "dockerConfig", "connectionFile", "roleMapping"]
        : ["root", "dockerConfig", "activation"],
    );
    const admission = record.phase === "prepare" ? op.admission : op.activation.admission;
    ensure(
      typeof admission.identity.executorSha === "string" &&
        /^[a-f0-9]{40}$/u.test(admission.identity.executorSha),
    );
    ensure(
      record.installedRoot ===
        (options.installedRoot ??
          `/opt/markiro-platform/recovery-bootstrap/${admission.identity.executorSha}`),
    );
    const stateRoot = options.root ?? "/opt/markiro-platform/state";
    const operationsRoot = options.root
      ? join(options.root, "recovery-operations")
      : "/opt/markiro-platform/recovery-operations";
    ensure(
      op.root === stateRoot &&
        directory === join(operationsRoot, admission.identity.operationId, record.phase),
    );
    assertPrivateRootSync(record.installedRoot);
    assertPrivateRootSync(op.root);
    assertPrivateRootSync(op.dockerConfig);
    ensure(op.dockerConfig === join(op.root, "docker"));
    const receiptName = `recovery-installed-executor-${admission.identity.operationId}.json`;
    const receiptBytes = await readPrivateFile(op.root, receiptName);
    const receipt = JSON.parse(receiptBytes);
    keys(receipt, [
      "version",
      "kind",
      "operationId",
      "executorSha",
      "ci",
      "installationDispatch",
      "files",
    ]);
    ensure(
      receipt.version === 1 &&
        receipt.kind === "platform-recovery-installed-executor" &&
        receipt.executorSha === admission.identity.executorSha &&
        receipt.operationId === admission.identity.operationId,
    );
    ci(receipt.ci);
    same(receipt.ci, admission.executorCi);
    dispatch(receipt.installationDispatch);
    if (record.phase === "prepare") same(receipt.installationDispatch, record.dispatch);
    keys(receipt.files, RECOVERY_BUNDLE_FILES);
    for (const sha of Object.values(receipt.files))
      ensure(typeof sha === "string" && /^[a-f0-9]{64}$/u.test(sha));
    const verifySources = async () => {
      ensure((await readPrivateFile(directory, "operation.json")).equals(operationBytes));
      ensure((await readPrivateFile(op.root, receiptName)).equals(receiptBytes));
      for (const path of RECOVERY_BUNDLE_FILES) {
        let bytes;
        if (path.endsWith("/pg_hba.conf")) {
          const file = join(record.installedRoot, path);
          assertBindFileSync(file);
          const info = await lstat(file);
          ensure([0, process.getuid()].includes(info.uid) && (info.mode & 0o7777) === 0o644);
          bytes = await readFile(file);
          assertBindFileSync(file);
        } else bytes = await readPrivateFile(record.installedRoot, path);
        ensure(digest(bytes) === receipt.files[path]);
      }
    };
    await verifySources();
    // The caller trusts this loader and its small verification primitives. All
    // phase-specific code, including ordinary adapter dependencies, is now hashed.
    const runtime = await import(
      pathToFileURL(join(record.installedRoot, "deploy/platform/host/recovery-command-runtime.mjs"))
        .href
    );
    const loaded = {
      operationDirectory: directory,
      record: freeze(record),
      receipt: freeze(receipt),
      verifySources,
    };
    await runtime.validateRecoveryOperation(loaded, options);
    await verifySources();
    loads.add(loaded);
    return Object.freeze(loaded);
  } catch (error) {
    throw failure(error);
  }
}
export async function runRecoveryHostCommand(args, options = {}) {
  let phase, loaded;
  try {
    ensure(
      Array.isArray(args) &&
        args.length === 2 &&
        ["prepare", "activate"].includes(args[0]) &&
        typeof args[1] === "string",
    );
    loaded = await loadRecoveryOperation(args[1], options);
    ensure(loads.has(loaded) && loaded.record.phase === args[0]);
    phase = args[0];
    await loaded.verifySources();
    const runtime = await import(
      pathToFileURL(
        join(loaded.record.installedRoot, "deploy/platform/host/recovery-command-runtime.mjs"),
      ).href
    );
    await runtime.executeRecoveryOperation(loaded, options);
    return Object.freeze({
      version: 1,
      kind: "platform-recovery-host-outcome",
      phase,
      status: phase === "prepare" ? "backup-verified" : "healthy",
    });
  } catch (error) {
    if (loaded) {
      try {
        phase = JSON.parse(
          await readPrivateFile(loaded.record.operation.root, "recovery-state.json"),
        ).phase;
      } catch {
        /* No durable sidecar established. */
      }
    }
    throw failure(error, error?.phase ?? phase);
  }
}
// Programmatic command boundary only. The protected receiver/workflow is a later
// review gate; importing this file cannot execute a phase from process.argv.
export function recoveryCommandFailure(error) {
  return {
    version: 1,
    kind: "platform-recovery-host-command-failure",
    code: "ERR_HOST_RECOVERY_COMMAND",
    phase: [
      "prepare",
      "activate",
      "admitted",
      "target-stopped",
      "backup-verified",
      "activation-admitted",
      "images-verified",
      "api-started",
      "edge-started",
      "healthy",
    ].includes(error?.phase)
      ? error.phase
      : null,
    terminationConfirmed: error?.terminationConfirmed === false ? false : null,
    recoveryRequired: true,
    durabilityUncertain: error?.durabilityUncertain === true,
  };
}
