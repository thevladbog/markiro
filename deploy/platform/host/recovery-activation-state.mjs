import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateFile, writePrivateFile } from "./files.mjs";
import { withHostState, assertLegacyWriteOwnership } from "./state.mjs";
import { stateError } from "./state-validation.mjs";
import {
  activationHash,
  snapshotActivation,
  validateRecoveryActivationAdmission,
} from "./recovery-activation-admission.mjs";

const phases = ["activation-admitted", "images-verified", "api-started", "edge-started", "healthy"];
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

// Separate from preparation: neither historical expiry nor an existing sidecar
// permits resume. No caller-selected token directory or record name is accepted.
export async function withRecoveryActivationState(root, input, callback, { now = Date.now } = {}) {
  const envelope = snapshotActivation(input); // before the first await
  return withHostState(root, async (host) => {
    await assertLegacyWriteOwnership(root);
    let active = true,
      state,
      preparationBytes,
      originalBytes,
      consumptionBytes,
      consumptionName;
    const integrity = async () => {
      const currentOriginal = await readPrivateFile(root, "state.json");
      if (originalBytes && !currentOriginal.equals(originalBytes)) throw stateError();
      const preserved = await readPrivateFile(root, "recovery-preparation.json");
      if (!preserved.equals(preparationBytes)) throw stateError();
      if (state && !(await readPrivateFile(root, "recovery-state.json")).equals(bytes(state)))
        throw stateError();
      if (
        consumptionBytes &&
        !(await readPrivateFile(root, consumptionName)).equals(consumptionBytes)
      )
        throw stateError();
    };
    const check = async () => {
      await integrity();
      if (state?.status === "recovery-required") throw stateError();
      return validateRecoveryActivationAdmission(envelope, {
        stateBytes: originalBytes,
        preparationBytes,
        now: now(),
      });
    };
    const guarded = (action) =>
      host.guardPersistence(async (capability) => {
        if (!active) throw stateError();
        await check();
        try {
          return await action(capability);
        } catch (error) {
          if (error?.terminationConfirmed === false) throw stateError(true);
          throw error;
        }
      });
    const save = async (next) => {
      await assertLegacyWriteOwnership(root);
      await writePrivateFile(root, "recovery-state.json", bytes(next), { replace: true });
      state = next;
    };
    await host.guardPersistence(async () => {
      if (typeof callback !== "function") throw stateError();
      originalBytes = await readPrivateFile(root, "state.json");
      preparationBytes = await readPrivateFile(root, "recovery-state.json");
      validateRecoveryActivationAdmission(envelope, {
        stateBytes: originalBytes,
        preparationBytes,
        now: now(),
      });
      const operationId = envelope.admission.identity.operationId;
      consumptionName = `recovery-activation-${operationId}.json`;
      await absent(root, "recovery-preparation.json");
      await absent(root, consumptionName);
      await writePrivateFile(root, "recovery-preparation.json", preparationBytes);
      consumptionBytes = bytes({
        version: 1,
        kind: "platform-recovery-activation-consumption",
        operationId,
        preparationSha256: envelope.preparation.sha256,
        activationSha256: activationHash(Buffer.from(JSON.stringify(envelope))),
        dispatch: envelope.dispatch,
      });
      await writePrivateFile(root, consumptionName, consumptionBytes);
      await check();
      const preparation = JSON.parse(preparationBytes.toString("utf8"));
      await save({
        ...preparation,
        sequence: 7,
        phase: "activation-admitted",
        status: "entered",
        preparation: envelope.preparation,
        activation: envelope,
      });
    });
    // Failure is a terminal integrity-preserving write, never authorization for
    // more work. Expiry cannot prevent publishing failure of admitted work.
    const fail = () =>
      host.guardPersistence(async () => {
        if (!active) throw stateError();
        try {
          await integrity();
        } catch {
          throw stateError(true);
        }
        if (state.phase === "healthy" && state.status === "completed") throw stateError();
        if (state.status === "recovery-required") return;
        await save({ ...state, sequence: state.sequence + 1, status: "recovery-required" });
      });
    const store = Object.freeze({
      fail,
      // Terminal cleanup keeps persistence ownership and immutable state checks,
      // while expiry cannot prevent stopping workloads started by this owner.
      cleanup: (action) =>
        host.guardPersistence(async () => {
          if (!active || state.status !== "recovery-required" || typeof action !== "function")
            throw stateError();
          await integrity();
          const result = await action();
          await integrity();
          return result;
        }),
      read: () => guarded(() => snapshotActivation(state)),
      guard: (action) =>
        guarded((capability) => {
          if (typeof action !== "function") throw stateError();
          return action(capability);
        }),
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
          if (state.phase !== phase || state.status !== "entered" || proof.length)
            throw stateError();
          await save({ ...state, sequence: state.sequence + 1, status: "completed" });
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
