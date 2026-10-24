// Separate immutable loader. Runtime imports happen only after full byte closure
// verification; operation JSON is data and never supplies executable adapters.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, lstat } from "node:fs/promises";
import { canonical, digest, ensure, keys } from "../backup/schemas.mjs";
import { canonicalId } from "../release-admission.mjs";
import { validateUpgradeDispatch, validateUpgradeAuthorization } from "../upgrade-dispatch.mjs";
import { assertPrivateRootSync, assertBindFileSync, readPrivateFile } from "./files.mjs";
import { RECOVERY_BUNDLE_FILES } from "./recovery-command.mjs";
export const UPGRADE_BUNDLE_FILES = Object.freeze([
  ...RECOVERY_BUNDLE_FILES,
  "deploy/platform/upgrade-dispatch.mjs",
  "deploy/platform/upgrade-transport.mjs",
  "deploy/platform/host/upgrade-command.mjs",
  "deploy/platform/host/upgrade-command-runtime.mjs",
  "deploy/platform/host/upgrade-observation.mjs",
  "deploy/platform/host/upgrade-schema.mjs",
  "deploy/platform/host/upgrade-preparation.mjs",
  "deploy/platform/host/upgrade-activation.mjs",
  "deploy/platform/host/upgrade-activation-adapters.mjs",
  "deploy/platform/host/upgrade-return.mjs",
  "deploy/platform/host/upgrade-workloads.mjs",
]);
const same = (a, b) => ensure(canonical(a) === canonical(b));
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const failure = (error) => {
  const result = new Error("Platform upgrade host command rejected.");
  result.code = "ERR_UPGRADE_COMMAND";
  result.recoveryRequired = true;
  if (error?.terminationConfirmed === false) result.terminationConfirmed = false;
  if (error?.durabilityUncertain === true) result.durabilityUncertain = true;
  return result;
};
export async function loadUpgradeOperation(directory, options = {}) {
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
      "authorization",
      "operation",
      "observationPolicy",
    ]);
    ensure(
      record.version === 1 &&
        record.kind === "platform-upgrade-host-operation" &&
        ["prepare", "activate", "return-old"].includes(record.phase),
    );
    validateUpgradeDispatch(record.dispatch);
    validateUpgradeAuthorization(record.authorization);
    const op = record.operation;
    keys(op, [
      "root",
      "dockerConfig",
      "admission",
      "configuration",
      "predecessorContainers",
      ...(record.phase === "prepare" ? ["connectionFile", "roleMapping"] : ["decision"]),
      ...(record.phase === "activate" ? ["preparedTarget", "preparedPolicy"] : []),
    ]);
    const identity = op.admission.identity;
    ensure(
      typeof identity.executorSha === "string" && /^[a-f0-9]{40}$/u.test(identity.executorSha),
    );
    ensure(
      typeof identity.operationId === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
          identity.operationId,
        ),
    );
    const hostRoot = options.hostRoot ?? "/opt/markiro-platform";
    ensure(op.root === join(hostRoot, "state") && op.dockerConfig === join(op.root, "docker"));
    ensure(directory === join(hostRoot, "upgrade-operations", identity.operationId, record.phase));
    ensure(record.installedRoot === join(hostRoot, "upgrade-bootstrap", identity.executorSha));
    for (const path of [record.installedRoot, op.root, op.dockerConfig])
      assertPrivateRootSync(path);
    same(
      record.dispatch,
      record.phase === "prepare" ? op.admission.dispatch : op.decision.dispatch,
    );
    const receiptName = `upgrade-installed-executor-${identity.operationId}.json`;
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
        receipt.kind === "platform-upgrade-installed-executor" &&
        receipt.operationId === identity.operationId &&
        receipt.executorSha === identity.executorSha,
    );
    keys(receipt.ci, ["runId", "runAttempt"]);
    ensure(Object.values(receipt.ci).every(canonicalId));
    same(receipt.ci, op.admission.executorCi);
    validateUpgradeDispatch(receipt.installationDispatch);
    same(receipt.installationDispatch, op.admission.dispatch);
    keys(receipt.files, UPGRADE_BUNDLE_FILES);
    ensure(
      Object.values(receipt.files).every((v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v)),
    );
    const verifyBytes = async () => {
      ensure((await readPrivateFile(directory, "operation.json")).equals(operationBytes));
      ensure((await readPrivateFile(op.root, receiptName)).equals(receiptBytes));
      for (const path of UPGRADE_BUNDLE_FILES) {
        let bytes;
        if (path.endsWith("/pg_hba.conf")) {
          const file = join(record.installedRoot, path);
          assertBindFileSync(file);
          const stat = await lstat(file);
          ensure([0, process.getuid()].includes(stat.uid) && (stat.mode & 0o7777) === 0o644);
          bytes = await readFile(file);
          assertBindFileSync(file);
        } else bytes = await readPrivateFile(record.installedRoot, path);
        ensure(digest(bytes) === receipt.files[path]);
      }
    };
    await verifyBytes();
    const runtime = await import(
      pathToFileURL(join(record.installedRoot, "deploy/platform/host/upgrade-command-runtime.mjs"))
        .href
    );
    let verifyAuthority;
    const loaded = {
      operationDirectory: directory,
      record: freeze(record),
      receipt: freeze(receipt),
      verifySources: async () => {
        await verifyBytes();
        await verifyAuthority();
        await verifyBytes();
      },
    };
    verifyAuthority = await runtime.validateUpgradeOperation(loaded, options);
    ensure(typeof verifyAuthority === "function");
    await loaded.verifySources();
    return Object.freeze(loaded);
  } catch (error) {
    throw failure(error);
  }
}

export async function runUpgradeHostCommand(args, options = {}) {
  try {
    ensure(
      Array.isArray(args) &&
        args.length === 2 &&
        ["prepare", "activate", "return-old"].includes(args[0]) &&
        typeof args[1] === "string",
    );
    const loaded = await loadUpgradeOperation(args[1], options);
    ensure(loaded.record.phase === args[0]);
    await loaded.verifySources();
    const runtime = await import(
      pathToFileURL(
        join(loaded.record.installedRoot, "deploy/platform/host/upgrade-command-runtime.mjs"),
      ).href
    );
    await runtime.executeUpgradeOperation(loaded, options);
    return Object.freeze({
      version: 1,
      kind: "platform-upgrade-host-outcome",
      phase: args[0],
      status: { prepare: "backup-verified", activate: "healthy", "return-old": "returned-old" }[
        args[0]
      ],
    });
  } catch (error) {
    throw failure(error);
  }
}
