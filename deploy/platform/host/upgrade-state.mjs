import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withHostState, withHeldHostState } from "./state.mjs";
import { stateError, validateBackup, validateIdentity } from "./state-validation.mjs";
import { createPrivateDirectory, readPrivateFile, writePrivateFile } from "./files.mjs";
import { activationHash, snapshotActivation } from "./recovery-activation-admission.mjs";
import { validateUpgradeAdmission } from "./upgrade-admission.mjs";
import {
  upgradePhaseGraphs,
  validateUpgradeJournal,
  validateUpgradePhaseAdmission,
  upgradePhaseReceipt,
} from "./upgrade-phase-admission.mjs";

import { validateOldRuntime, validateUpgradePreparation } from "./upgrade-proofs.mjs";

const upgradeCapabilities = new WeakMap();

// Only a capability issued by this store can read upgrade authority. The host
// consumes and drains it; neither an ordinary token nor JSON can impersonate it.
export async function withHeldUpgradeState(capability, action) {
  const held = upgradeCapabilities.get(capability);
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
          oldRuntime: null,
          preparation: null,
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
          upgradeCapabilities.set(capability, async () => {
            if (!active) throw stateError();
            await integrity();
            await checkAdmission();
            if (state.status === "recovery-required") throw stateError();
            return {
              root,
              state: snapshotActivation(state),
              predecessor: snapshotActivation(
                JSON.parse(
                  (await readUpgradePredecessor(root, admission.predecessor.identity))
                    .activationOperation,
                ),
              ),
            };
          });
          // Host capability lifetime/single-use/drain is authoritative. The
          // WeakMap entry cannot make a revoked host token live again.
          return action(capability);
        }),
      fail,
      enter: (phase) =>
        guarded(async () => {
          if (
            state.status !== "completed" ||
            !phases.includes(phase) ||
            (phase === "old-stopped" && !state.oldRuntime) ||
            phases.indexOf(phase) !== phases.indexOf(state.phase) + 1
          )
            throw stateError();
          await save({ ...state, sequence: state.sequence + 1, phase, status: "entered" });
        }),
      complete: (phase, ...proof) =>
        guarded(async () => {
          if (state.phase !== phase || state.status !== "entered") throw stateError();
          let backup = state.backup;
          let oldRuntime = state.oldRuntime;
          let preparation = state.preparation;
          if (phase === "admitted") {
            if (proof.length !== 1) throw stateError();
            oldRuntime = validateOldRuntime(proof[0], admission);
          } else if (phase === "backup-verified") {
            if (proof.length !== 2 || !oldRuntime) throw stateError();
            backup = validateBackup(snapshotActivation(proof[0]), admission.identity);
            preparation = validateUpgradePreparation(proof[1], admission, oldRuntime, backup);
          } else if (proof.length) throw stateError();
          await save({
            ...state,
            sequence: state.sequence + 1,
            status: "completed",
            backup,
            oldRuntime,
            preparation,
          });
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

// A fresh decision consumes the exact current state; it is never a resume API.
// Historical journals and receipts remain at fixed create-only paths. Only the
// one failed pre-latch activation may be followed by one separately admitted return.
export async function withUpgradePhaseState(root, input, callback, { now = Date.now } = {}) {
  const decision = snapshotActivation(input);
  // Validate identity before constructing any path, including rejected inputs.
  validateIdentity(decision.identity);
  if (!["activate", "return-old"].includes(decision.phase)) throw stateError();
  return withHostState(root, async (host) => {
    let active = true,
      state,
      index,
      prior,
      priorBytes,
      admission;
    const directory = `upgrade-operations/${decision.identity.operationId}`;
    const stateName = `${directory}/state.json`;
    const retained = new Map();
    const remember = async (name) => {
      const actual = await readPrivateFile(root, name);
      if (retained.has(name) && !retained.get(name).equals(actual)) throw stateError();
      retained.set(name, actual);
      return actual;
    };
    const loadHistory = async (value, depth = 0) => {
      if (depth > 2) throw stateError();
      const candidate = JSON.parse(value);
      if (candidate.decision) {
        const mode = candidate.decision.phase;
        if (!["activate", "return-old"].includes(mode)) throw stateError();
        const previousBytes = await remember(`${directory}/before-${mode}.json`);
        const previous = await loadHistory(previousBytes, depth + 1);
        validateUpgradePhaseAdmission(candidate.decision, {
          priorBytes: previousBytes,
          prior: previous,
          now: Date.parse(candidate.decision.expiresAt) - 1,
        });
        const receipt = await remember(`${directory}/${mode}-consumption.json`);
        if (!receipt.equals(bytes(upgradePhaseReceipt(candidate.decision)))) throw stateError();
        return validateUpgradeJournal(candidate, previous);
      }
      return validateUpgradeJournal(candidate);
    };
    const historical = async () => {
      await validateUpgradeAdmission(admission, {
        predecessorBytes: await readUpgradePredecessor(root, admission.predecessor.identity),
        now: Date.parse(admission.expiresAt) - 1,
      });
    };
    const integrity = async () => {
      await historical();
      for (const [name, value] of retained)
        if (!(await readPrivateFile(root, name)).equals(value)) throw stateError();
      if (
        !(await readPrivateFile(root, stateName)).equals(bytes(state)) ||
        !(await readPrivateFile(root, "upgrade-index.json")).equals(bytes(index))
      )
        throw stateError();
    };
    const check = () => validateUpgradePhaseAdmission(decision, { priorBytes, prior, now: now() });
    const save = async (next) => {
      validateUpgradeJournal(next, prior);
      const encoded = bytes(next);
      await writePrivateFile(root, stateName, encoded, { replace: true });
      const nextIndex = { ...index, stateSha256: activationHash(encoded) };
      await writePrivateFile(root, "upgrade-index.json", bytes(nextIndex), { replace: true });
      state = next;
      index = nextIndex;
    };
    const guarded = (action) =>
      host.guardPersistence(async (cap) => {
        if (!active || state.status === "recovery-required") throw stateError();
        await integrity();
        check();
        const result = await action(cap);
        await integrity();
        check();
        return result;
      });
    const graph = upgradePhaseGraphs[decision.phase];
    const fail = () =>
      host.guardPersistence(async () => {
        if (!active) throw stateError();
        try {
          await integrity();
        } catch {
          throw stateError(true);
        }
        if (state.status === "recovery-required") return;
        if (state.phase === graph.at(-1) && state.status === "completed") throw stateError();
        await save({ ...state, sequence: state.sequence + 1, status: "recovery-required" });
      });
    const store = Object.freeze({
      cleanup: (action) =>
        host.guardPersistence(async (cap) => {
          if (!active || state.status !== "recovery-required" || typeof action !== "function")
            throw stateError();
          await integrity();
          upgradeCapabilities.set(cap, async () => {
            if (!active || state.status !== "recovery-required") throw stateError();
            await integrity();
            return {
              root,
              state: snapshotActivation(state),
              cleanup: true,
              predecessor: snapshotActivation(
                JSON.parse(
                  (await readUpgradePredecessor(root, admission.predecessor.identity))
                    .activationOperation,
                ),
              ),
            };
          });
          const result = await action(cap);
          await integrity();
          return result;
        }),
      read: () => guarded(() => snapshotActivation(state)),
      fail,
      guard: (action) =>
        guarded((cap) => {
          if (typeof action !== "function") throw stateError();
          upgradeCapabilities.set(cap, async () => {
            if (!active || state.status === "recovery-required") throw stateError();
            await integrity();
            check();
            return {
              root,
              state: snapshotActivation(state),
              predecessor: snapshotActivation(
                JSON.parse(
                  (await readUpgradePredecessor(root, admission.predecessor.identity))
                    .activationOperation,
                ),
              ),
            };
          });
          return action(cap);
        }),
      enter: (phase) =>
        guarded(async () => {
          if (
            state.status !== "completed" ||
            !graph.includes(phase) ||
            graph.indexOf(phase) !== graph.indexOf(state.phase) + 1
          )
            throw stateError();
          await save({
            ...state,
            sequence: state.sequence + 1,
            phase,
            status: "entered",
            migrationEntered: state.migrationEntered || phase === "migration-entered",
          });
        }),
      complete: (phase, ...proof) =>
        guarded(async () => {
          if (state.phase !== phase || state.status !== "entered" || proof.length)
            throw stateError();
          await save({ ...state, sequence: state.sequence + 1, status: "completed" });
        }),
    });
    try {
      await host.guardPersistence(async () => {
        if (typeof callback !== "function") throw stateError();
        priorBytes = await readPrivateFile(root, stateName);
        prior = await loadHistory(priorBytes);
        admission = prior.admission;
        await historical();
        check();
        index = JSON.parse(await readPrivateFile(root, "upgrade-index.json"));
        const expected = {
          version: 1,
          kind: "platform-upgrade-index",
          operationId: decision.identity.operationId,
          stateSha256: activationHash(priorBytes),
        };
        if (!bytes(index).equals(bytes(expected))) throw stateError();
        const receipt = await remember(`${directory}/prepare-consumption.json`);
        if (
          !receipt.equals(
            bytes({
              version: 1,
              kind: "platform-upgrade-prepare-consumption",
              operationId: decision.identity.operationId,
              admissionSha256: activationHash(bytes(admission)),
              dispatch: admission.dispatch,
            }),
          )
        )
          throw stateError();
        const archiveName = `${directory}/before-${decision.phase}.json`;
        const receiptName = `${directory}/${decision.phase}-consumption.json`;
        await absent(root, archiveName);
        await absent(root, receiptName);
        // Every mutation after these exclusive publications is guarded durability.
        await writePrivateFile(root, archiveName, priorBytes);
        retained.set(archiveName, priorBytes);
        const consumed = bytes(upgradePhaseReceipt(decision));
        await writePrivateFile(root, receiptName, consumed);
        retained.set(receiptName, consumed);
        await save({
          ...prior,
          decision,
          sequence: prior.sequence + 1,
          phase: upgradePhaseGraphs[decision.phase][0],
          status: "entered",
          migrationEntered: false,
        });
        await integrity();
        check();
      });
      return await callback(store);
    } catch (error) {
      if (error?.terminationConfirmed === false || error?.durabilityUncertain === true)
        throw stateError(true);
      if (state) await fail().catch(() => {});
      throw error;
    } finally {
      active = false;
    }
  });
}
