import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withHostState } from "./state.mjs";
import { stateError, validateBackup, validateIdentity } from "./state-validation.mjs";
import { createPrivateDirectory, readPrivateFile, writePrivateFile } from "./files.mjs";
import { activationHash, snapshotActivation } from "./recovery-activation-admission.mjs";
import { validateUpgradeAdmission } from "./upgrade-admission.mjs";

const phases = ["admitted", "old-stopped", "backup-verified"];
const bytes = (value) => Buffer.from(JSON.stringify(value) + "\n");
async function absent(root, name) {
  try {
    await lstat(join(root, name));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw stateError();
}

export async function readUpgradePredecessor(root, identity) {
  validateIdentity(identity); // before using the historical UUID in a fixed path
  const result = {};
  for (const [name, path] of [
    ["original", "state.json"],
    ["acceptedRecovery", "recovery-state.json"],
    ["preparation", "recovery-preparation.json"],
    ["consumption", `recovery-activation-${identity.operationId}.json`],
  ])
    result[name] = await readPrivateFile(root, path);
  result.activationOperation = await readPrivateFile(
    dirname(root),
    `recovery-operations/${identity.operationId}/activate/operation.json`,
  );
  if (JSON.parse(result.activationOperation).operation.root !== root) throw stateError();
  return result;
}

// First-upgrade prepare only. Existing index (including terminal success) is
// never retired here. Later activation/return require separate fresh admissions.
// All writes and producer lifetimes belong to the existing target-wide lock.
export async function withUpgradeState(root, input, callback, { now = Date.now } = {}) {
  const admission = snapshotActivation(input);
  return withHostState(root, async (host) => {
    let active = true,
      state,
      index,
      consumed;
    const operationId = admission.identity.operationId;
    const directory = `upgrade-operations/${operationId}`;
    const stateName = `${directory}/state.json`;
    const consumptionName = `${directory}/prepare-consumption.json`;
    const checkAdmission = async () =>
      validateUpgradeAdmission(admission, {
        predecessorBytes: await readUpgradePredecessor(root, admission.predecessor.identity),
        now: now(),
      });
    const integrity = async () => {
      // Historical integrity is checked even when new authorization has expired.
      await validateUpgradeAdmission(admission, {
        predecessorBytes: await readUpgradePredecessor(root, admission.predecessor.identity),
        now: Date.parse(admission.expiresAt) - 1,
      });
      if (!state || !index || !consumed) throw stateError();
      if (
        !(await readPrivateFile(root, stateName)).equals(bytes(state)) ||
        !(await readPrivateFile(root, "upgrade-index.json")).equals(bytes(index)) ||
        !(await readPrivateFile(root, consumptionName)).equals(bytes(consumed))
      )
        throw stateError();
    };
    const save = async (next, first = false) => {
      const nextBytes = bytes(next);
      await writePrivateFile(root, stateName, nextBytes, { replace: !first });
      // A crash between these durable writes leaves mismatched hashes and the
      // shared lock: no subsequent action or different UUID can bypass it.
      const nextIndex = { ...index, stateSha256: activationHash(nextBytes) };
      await writePrivateFile(root, "upgrade-index.json", bytes(nextIndex), { replace: true });
      state = next;
      index = nextIndex;
    };
    const guarded = (action) =>
      host.guardPersistence(async (capability) => {
        if (!active) throw stateError();
        await integrity();
        await checkAdmission();
        if (state.status === "recovery-required") throw stateError();
        const result = await action(capability);
        await integrity();
        await checkAdmission();
        return result;
      });
    await host.guardPersistence(async () => {
      if (typeof callback !== "function") throw stateError();
      await checkAdmission();
      await absent(root, "upgrade-index.json");
      index = { version: 1, kind: "platform-upgrade-index", operationId, stateSha256: null };
      await writePrivateFile(root, "upgrade-index.json", bytes(index));
      await createPrivateDirectory(root, "upgrade-operations", { exclusive: false });
      await createPrivateDirectory(root, directory);
      consumed = {
        version: 1,
        kind: "platform-upgrade-prepare-consumption",
        operationId,
        admissionSha256: activationHash(bytes(admission)),
        dispatch: admission.dispatch,
      };
      await writePrivateFile(root, consumptionName, bytes(consumed));
      await save(
        {
          version: 1,
          admission,
          sequence: 1,
          phase: "admitted",
          status: "entered",
          backup: null,
          migrationEntered: false,
        },
        true,
      );
      await integrity();
      await checkAdmission();
    });
    const fail = () =>
      host.guardPersistence(async () => {
        if (!active) throw stateError();
        try {
          await integrity();
        } catch {
          throw stateError(true);
        }
        if (state.status === "recovery-required") return;
        await save({ ...state, sequence: state.sequence + 1, status: "recovery-required" });
      });
    const store = Object.freeze({
      read: () => guarded(() => snapshotActivation(state)),
      guard: (action) =>
        guarded(async (capability) => {
          if (typeof action !== "function") throw stateError();
          return action(capability);
        }),
      fail,
      enter: (phase) =>
        guarded(async () => {
          if (
            state.status !== "completed" ||
            !phases.includes(phase) ||
            phases.indexOf(phase) !== phases.indexOf(state.phase) + 1
          )
            throw stateError();
          await save({ ...state, sequence: state.sequence + 1, phase, status: "entered" });
        }),
      complete: (phase, ...proof) =>
        guarded(async () => {
          if (state.phase !== phase || state.status !== "entered") throw stateError();
          let backup = state.backup;
          if (phase === "backup-verified") {
            if (proof.length !== 1) throw stateError();
            backup = validateBackup(snapshotActivation(proof[0]), admission.identity);
          } else if (proof.length) throw stateError();
          await save({ ...state, sequence: state.sequence + 1, status: "completed", backup });
        }),
    });
    try {
      return await callback(store);
    } catch (error) {
      if (error?.terminationConfirmed === false || error?.durabilityUncertain === true)
        throw stateError(true);
      await fail().catch(() => {});
      throw error;
    } finally {
      active = false;
    }
  });
}
