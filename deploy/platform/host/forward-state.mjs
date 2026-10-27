import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, ensure, hash, keys } from "../backup/schemas.mjs";
import { withHostState, withHeldHostState } from "./state.mjs";
import { stateError, validateIdentity, validateBackup } from "./state-validation.mjs";
import { snapshotActivation, activationHash } from "./recovery-activation-admission.mjs";
import { createPrivateDirectory, readPrivateFile, writePrivateFile } from "./files.mjs";
import { validateForwardDecision } from "./forward-admission.mjs";
import {
  readForwardHistory,
  validateForwardHistory,
  forwardImmediatePredecessor,
} from "./forward-history.mjs";
import { runHostProcess } from "./process.mjs";
import { carryHostFailure } from "./failure-diagnostic.mjs";

export const forwardGraphs = Object.freeze({
  "post-migration-prepare": Object.freeze(["admitted", "source-held", "backup-verified"]),
  "post-migration-activate": Object.freeze([
    "activation-admitted",
    "api-started",
    "edge-started",
    "healthy",
  ]),
});
const capabilities = new WeakMap();
const bytes = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
const same = (a, b) => ensure(canonical(a) === canonical(b));
export const forwardPhaseReceipt = (decision) => ({
  version: 1,
  kind: "platform-forward-phase-consumption",
  operationId: decision.identity.operationId,
  phase: decision.phase,
  priorSha256:
    decision.phase === "post-migration-prepare"
      ? forwardImmediatePredecessor(decision).hashes.state
      : decision.prior.sha256,
  admissionSha256: activationHash(bytes(decision)),
  dispatch: decision.dispatch,
});
export function validateForwardSourceRuntime(input, admission) {
  const value = snapshotActivation(input);
  keys(value, [
    "version",
    "kind",
    "operationId",
    "configurationSha256",
    "containers",
    "schema",
    "productMigrationProofSha256",
  ]);
  ensure(
    value.version === 1 &&
      value.kind === "platform-forward-source-runtime" &&
      value.operationId === admission.identity.operationId &&
      value.configurationSha256 === admission.candidateConfigurationSha256,
  );
  for (const key of ["containers", "schema", "productMigrationProofSha256"])
    same(value[key], admission.baseline[key]);
  return value;
}
export function validateForwardPreparation(input, admission, sourceRuntime, backup) {
  const value = snapshotActivation(input);
  keys(value, [
    "version",
    "kind",
    "operationId",
    "sourceRuntime",
    "backup",
    "sourceSchema",
    "productMigrationProofSha256",
    "fence",
  ]);
  ensure(
    value.version === 1 &&
      value.kind === "platform-forward-preparation" &&
      value.operationId === admission.identity.operationId,
  );
  same(validateForwardSourceRuntime(value.sourceRuntime, admission), sourceRuntime);
  same(validateBackup(value.backup, admission.identity), backup);
  same(value.sourceSchema, admission.baseline.schema);
  same(value.productMigrationProofSha256, admission.baseline.productMigrationProofSha256);
  keys(value.fence, ["fenceId", "beganAt", "enforcementSha256"]);
  ensure(
    typeof value.fence.fenceId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        value.fence.fenceId,
      ) &&
      hash(value.fence.enforcementSha256) &&
      typeof value.fence.beganAt === "string" &&
      new Date(Date.parse(value.fence.beganAt)).toISOString() === value.fence.beganAt,
  );
  return value;
}
export function validateForwardJournal(input, prior = null) {
  const s = snapshotActivation(input);
  keys(s, [
    "version",
    "admission",
    "sequence",
    "phase",
    "status",
    "backup",
    "sourceRuntime",
    "preparation",
    "migrationEntered",
    ...(prior ? ["decision"] : []),
  ]);
  validateIdentity(s.admission.identity);
  ensure(
    s.version === 1 &&
      [
        "platform-upgrade-forward-recovery",
        "platform-forward-admission-successor",
        "platform-forward-activation-successor",
      ].includes(s.admission.kind) &&
      s.admission.phase === "post-migration-prepare" &&
      s.migrationEntered === true &&
      Number.isSafeInteger(s.sequence) &&
      ["entered", "completed", "recovery-required"].includes(s.status),
  );
  const mode = prior ? s.decision.phase : "post-migration-prepare",
    graph = forwardGraphs[mode];
  ensure(graph);
  const index = graph.indexOf(s.phase),
    entered = (prior ? prior.sequence : 0) + 1 + 2 * index;
  ensure(
    index >= 0 &&
      (s.status === "entered"
        ? s.sequence === entered
        : s.status === "completed"
          ? s.sequence === entered + 1
          : [entered + 1, entered + 2].includes(s.sequence)),
  );
  if (s.sourceRuntime) validateForwardSourceRuntime(s.sourceRuntime, s.admission);
  if (s.backup) validateBackup(s.backup, s.admission.identity);
  if (s.preparation)
    validateForwardPreparation(s.preparation, s.admission, s.sourceRuntime, s.backup);
  if (prior) {
    for (const key of ["admission", "sourceRuntime", "backup", "preparation"])
      same(s[key], prior[key]);
  } else {
    if (index > 0 || s.status === "completed") ensure(s.sourceRuntime);
    if (index < 2 || s.status === "entered") ensure(s.backup === null && s.preparation === null);
    if (index === 2 && s.status === "completed") ensure(s.backup && s.preparation);
    ensure((s.backup === null) === (s.preparation === null));
  }
  return s;
}
async function metadata(path) {
  const info = await lstat(path, { bigint: true });
  ensure(
    info.isFile() &&
      info.nlink === 1n &&
      info.uid === BigInt(process.getuid()) &&
      (info.mode & 0o7777n) === 0o600n,
  );
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    uid: Number(info.uid),
    gid: Number(info.gid),
    mode: Number(info.mode & 0o7777n),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  throw stateError();
}
async function renameIndex({ root, destination, expected, sha256 }) {
  const result = await runHostProcess({
    executable: "/usr/bin/python3",
    args: ["-I", fileURLToPath(new URL("./forward-index-handoff.py", import.meta.url))],
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    input: bytes({ root, destination, expected, sha256 }),
    timeoutMs: 30000,
    outputLimitBytes: 4096,
  });
  return JSON.parse(result.stdout);
}
export async function withHeldForwardState(capability, action) {
  const held = capabilities.get(capability);
  if (!held || typeof action !== "function") throw stateError();
  return withHeldHostState(capability, async () => {
    let active = true;
    const verify = async () => {
      if (!active) throw stateError();
      return held();
    };
    try {
      const context = await verify();
      const result = await action({ ...context, verify });
      await verify();
      return result;
    } finally {
      active = false;
    }
  });
}
export async function withForwardPreparationState(root, admission, action, options = {}) {
  return withForwardState(root, admission, action, options, false);
}
export async function withForwardActivationState(root, decision, action, options = {}) {
  return withForwardState(root, decision, action, options, true);
}
async function withForwardState(root, input, action, options, activation) {
  const decision = snapshotActivation(input);
  validateIdentity(decision.identity);
  const {
    now = Date.now,
    productMigrationProof,
    verifyBaseline,
    checkpoint = async () => {},
  } = options;
  ensure(
    typeof now === "function" &&
      typeof verifyBaseline === "function" &&
      typeof checkpoint === "function",
  );
  return withHostState(root, async (host) => {
    let state,
      index,
      admission,
      prior,
      active = true,
      ownership = false;
    const id = decision.identity.operationId,
      directory = `forward-recovery-operations/${id}`,
      stateName = `${directory}/state.json`,
      archive = `${directory}/predecessor-index.json`;
    const retained = new Map();
    const retain = async (path) => {
      const value = await readPrivateFile(root, path);
      if (retained.has(path)) ensure(retained.get(path).equals(value));
      retained.set(path, value);
      return value;
    };
    const readHistory = async (historical = false) => {
      const history = await readForwardHistory(root, admission, { ownIndexArchive: ownership });
      if (ownership) await retain(archive);
      validateForwardHistory(admission, history, {
        productMigrationProof,
        now: historical ? Date.parse(admission.expiresAt) - 1 : now(),
      });
      return history;
    };
    const check = async (cleanup = false, physical = true) => {
      if (!active) throw stateError();
      await readHistory(true);
      if (!cleanup) {
        if (activation)
          validateForwardDecision(decision, {
            priorBytes: retained.get(`${directory}/before-post-migration-activate.json`),
            prior,
            now: now(),
          });
        else await readHistory(false);
      }
      if (physical)
        await verifyBaseline({
          root,
          admission,
          state: state ? snapshotActivation(state) : null,
          cleanup,
        });
    };
    const integrity = async () => {
      try {
        await readHistory(true);
        for (const [path, expected] of retained)
          ensure((await readPrivateFile(root, path)).equals(expected));
        ensure(
          state &&
            index &&
            (await readPrivateFile(root, stateName)).equals(bytes(state)) &&
            (await readPrivateFile(root, "upgrade-index.json")).equals(bytes(index)),
        );
        const intentBytes = retained.get(`${directory}/handoff-intent.json`);
        const intent = JSON.parse(intentBytes);
        const success = JSON.parse(retained.get(`${directory}/handoff-success.json`));
        keys(intent, [
          "version",
          "kind",
          "operationId",
          "failedOperationId",
          "expectedSha256",
          "originalMetadata",
          "admissionSha256",
        ]);
        keys(success, [
          "version",
          "kind",
          "operationId",
          "archivedSha256",
          "archivedMetadata",
          "originalMetadata",
          "intentSha256",
        ]);
        ensure(
          intent.version === 1 &&
            intent.kind === "platform-forward-index-handoff" &&
            intent.operationId === id &&
            intent.failedOperationId ===
              forwardImmediatePredecessor(admission).identity.operationId &&
            intent.expectedSha256 === forwardImmediatePredecessor(admission).hashes.index &&
            intent.admissionSha256 === activationHash(bytes(admission)),
        );
        ensure(
          success.version === 1 &&
            success.kind === "platform-forward-index-handoff-completed" &&
            success.operationId === id &&
            success.archivedSha256 === forwardImmediatePredecessor(admission).hashes.index &&
            success.intentSha256 === activationHash(intentBytes),
        );
        same(success.originalMetadata, intent.originalMetadata);
        for (const key of Object.keys(intent.originalMetadata))
          if (key !== "ctimeNs") same(success.archivedMetadata[key], intent.originalMetadata[key]);
        same(await metadata(join(root, archive)), success.archivedMetadata);
      } catch (error) {
        throw carryHostFailure(error, stateError(true));
      }
    };
    const indexFor = (s) => ({
      version: 1,
      kind: "platform-forward-recovery-index",
      operationId: id,
      stateSha256: activationHash(bytes(s)),
      predecessorIndexSha256: forwardImmediatePredecessor(admission).hashes.index,
      admissionSha256: activationHash(bytes(admission)),
    });
    const save = async (next, first = false) => {
      validateForwardJournal(next, prior);
      try {
        await writePrivateFile(root, stateName, bytes(next), { replace: !first });
        const nextIndex = indexFor(next);
        await writePrivateFile(root, "upgrade-index.json", bytes(nextIndex), { replace: !first });
        state = next;
        index = nextIndex;
      } catch (error) {
        throw carryHostFailure(error, stateError(true));
      }
    };
    await host.guardPersistence(async () => {
      ensure(typeof action === "function");
      if (activation) {
        const before = await readPrivateFile(root, stateName);
        prior = validateForwardJournal(JSON.parse(before));
        admission = prior.admission;
        ownership = true;
        await retain(`${directory}/handoff-intent.json`);
        await retain(`${directory}/handoff-success.json`);
        await retain(archive);
        await retain(`${directory}/prepare-consumption.json`);
        ensure(
          retained
            .get(`${directory}/prepare-consumption.json`)
            .equals(bytes(forwardPhaseReceipt(admission))),
        );
        await readHistory(true);
        validateForwardDecision(decision, { priorBytes: before, prior, now: now() });
        const actualIndex = await readPrivateFile(root, "upgrade-index.json");
        ensure(actualIndex.equals(bytes(indexFor(prior))));
        await verifyBaseline({ root, admission, state: prior, cleanup: false });
        try {
          const beforeName = `${directory}/before-post-migration-activate.json`,
            receiptName = `${directory}/activate-consumption.json`;
          await writePrivateFile(root, beforeName, before);
          retained.set(beforeName, before);
          const receipt = bytes(forwardPhaseReceipt(decision));
          await writePrivateFile(root, receiptName, receipt);
          retained.set(receiptName, receipt);
          await save({
            ...prior,
            decision,
            sequence: 7,
            phase: "activation-admitted",
            status: "entered",
          });
        } catch (error) {
          throw carryHostFailure(error, stateError(true));
        }
      } else {
        admission = decision;
        await readHistory(false);
        await verifyBaseline({ root, admission, state: null, cleanup: false });
        await readHistory(false);
        const oldIndex = await readPrivateFile(root, "upgrade-index.json"),
          beforeMetadata = await metadata(join(root, "upgrade-index.json"));
        ensure(activationHash(oldIndex) === forwardImmediatePredecessor(admission).hashes.index);
        await createPrivateDirectory(root, "forward-recovery-operations", { exclusive: false });
        await createPrivateDirectory(root, directory);
        await absent(join(root, archive));
        const intent = {
          version: 1,
          kind: "platform-forward-index-handoff",
          operationId: id,
          failedOperationId: forwardImmediatePredecessor(admission).identity.operationId,
          expectedSha256: forwardImmediatePredecessor(admission).hashes.index,
          originalMetadata: beforeMetadata,
          admissionSha256: activationHash(bytes(admission)),
        };
        // Every exception from this point through durable readback retains lock.
        try {
          await writePrivateFile(root, `${directory}/handoff-intent.json`, bytes(intent));
          await checkpoint("intent-written");
          same(await metadata(join(root, "upgrade-index.json")), beforeMetadata);
          ensure((await readPrivateFile(root, "upgrade-index.json")).equals(oldIndex));
          const actual = await (options.renameIndex ?? renameIndex)({
            root,
            destination: archive,
            expected: beforeMetadata,
            sha256: forwardImmediatePredecessor(admission).hashes.index,
            checkpoint,
          });
          const archived = await metadata(join(root, archive));
          same(actual, archived);
          for (const key of Object.keys(beforeMetadata))
            if (key !== "ctimeNs") same(archived[key], beforeMetadata[key]);
          ensure((await readPrivateFile(root, archive)).equals(oldIndex));
          await absent(join(root, "upgrade-index.json"));
          await checkpoint("archive-verified");
          ownership = true;
          const consumed = bytes(forwardPhaseReceipt(admission));
          await writePrivateFile(root, `${directory}/prepare-consumption.json`, consumed);
          retained.set(`${directory}/prepare-consumption.json`, consumed);
          state = {
            version: 1,
            admission,
            sequence: 1,
            phase: "admitted",
            status: "entered",
            backup: null,
            sourceRuntime: null,
            preparation: null,
            migrationEntered: true,
          };
          validateForwardJournal(state);
          await writePrivateFile(root, stateName, bytes(state));
          await checkpoint("state-written");
          index = indexFor(state);
          await writePrivateFile(root, "upgrade-index.json", bytes(index));
          await checkpoint("index-written");
          ensure(
            (await readPrivateFile(root, stateName)).equals(bytes(state)) &&
              (await readPrivateFile(root, "upgrade-index.json")).equals(bytes(index)),
          );
          await checkpoint("ownership-verified");
          const success = {
            version: 1,
            kind: "platform-forward-index-handoff-completed",
            operationId: id,
            archivedSha256: activationHash(oldIndex),
            archivedMetadata: archived,
            originalMetadata: beforeMetadata,
            intentSha256: activationHash(bytes(intent)),
          };
          await writePrivateFile(root, `${directory}/handoff-success.json`, bytes(success));
          await checkpoint("success-written");
          await retain(`${directory}/handoff-intent.json`);
          await retain(`${directory}/handoff-success.json`);
          await retain(archive);
        } catch (error) {
          throw carryHostFailure(error, stateError(true));
        }
      }
      await integrity();
      await check();
    });
    const pending = new Set();
    let closing = false;
    const guarded = (fn, cleanup = false) => {
      if (closing) return Promise.reject(stateError());
      const result = host.guardPersistence(async (capability) => {
        if (!active || (!cleanup && state.status === "recovery-required")) throw stateError();
        await integrity();
        await check(cleanup);
        const value = await fn(capability);
        await integrity();
        await check(cleanup);
        return value;
      });
      pending.add(result);
      result.then(
        () => pending.delete(result),
        () => pending.delete(result),
      );
      return result;
    };
    const fail = () =>
      host.guardPersistence(async () => {
        if (!active) throw stateError();
        await integrity();
        if (state.status !== "recovery-required")
          await save({ ...state, sequence: state.sequence + 1, status: "recovery-required" });
      });
    const heldAction = (fn, cleanup = false) =>
      guarded(async (capability) => {
        ensure(typeof fn === "function");
        capabilities.set(capability, async () => {
          await integrity();
          await check(cleanup, false);
          if (!cleanup) ensure(state.status !== "recovery-required");
          return { root, state: snapshotActivation(state), cleanup };
        });
        try {
          return await fn(capability);
        } finally {
          capabilities.delete(capability);
        }
      }, cleanup);
    const graph = forwardGraphs[activation ? "post-migration-activate" : "post-migration-prepare"];
    const store = Object.freeze({
      read: () => guarded(() => snapshotActivation(state)),
      guard: (fn) => heldAction(fn),
      cleanup: (fn) => heldAction(fn, true),
      fail,
      enter: (phase) =>
        guarded(async () => {
          ensure(
            state.status === "completed" &&
              graph.indexOf(phase) === graph.indexOf(state.phase) + 1 &&
              graph.includes(phase),
          );
          await save({ ...state, phase, status: "entered", sequence: state.sequence + 1 });
        }),
      complete: (phase, ...proof) =>
        guarded(async () => {
          ensure(state.phase === phase && state.status === "entered");
          let { sourceRuntime, backup, preparation } = state;
          if (!activation && phase === "admitted") {
            ensure(proof.length === 1);
            sourceRuntime = validateForwardSourceRuntime(proof[0], admission);
          } else if (!activation && phase === "backup-verified") {
            ensure(proof.length === 2 && sourceRuntime);
            backup = validateBackup(snapshotActivation(proof[0]), admission.identity);
            preparation = validateForwardPreparation(proof[1], admission, sourceRuntime, backup);
          } else ensure(proof.length === 0);
          await save({
            ...state,
            sourceRuntime,
            backup,
            preparation,
            status: "completed",
            sequence: state.sequence + 1,
          });
        }),
    });
    try {
      const result = await action(store);
      closing = true;
      const drained = await Promise.allSettled([...pending]);
      const rejected = drained.find((entry) => entry.status === "rejected");
      if (rejected) throw rejected.reason;
      return result;
    } catch (error) {
      if (error?.durabilityUncertain === true || error?.terminationConfirmed === false)
        throw carryHostFailure(error, stateError(true));
      await fail().catch(() => {});
      throw error;
    } finally {
      active = false;
    }
  });
}
