import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { readPrivateFile, writePrivateFile } from "./files.mjs";
import { withHostState } from "./state.mjs";
import { snapshot, stateError, validateBackup } from "./state-validation.mjs";
import { validateRecoveryAdmission } from "./recovery-admission.mjs";

// Initial recovery fence only. A stopped target is not a recovered deployment;
// later backup/activation stages require a separate reviewed admission boundary.
const phases = ["admitted", "target-stopped", "backup-verified"];
export async function withRecoveryState(root, input, callback, { now = Date.now } = {}) {
  const admittedInput = snapshot(input);
  return withHostState(root, async (host) => {
    let active = true;
    let state;
    let producerUsed = false;
    const check = async () =>
      validateRecoveryAdmission(admittedInput, {
        stateBytes: await readPrivateFile(root, "state.json"),
        now: now(),
      });
    const guarded = (action) =>
      host.guardPersistence(async (capability) => {
        if (!active) throw stateError();
        await check();
        return action(capability);
      });
    const save = async (next) => {
      await writePrivateFile(
        root,
        "recovery-state.json",
        Buffer.from(JSON.stringify(next) + "\n"),
        { replace: true },
      );
      state = next;
    };
    await guarded(async () => {
      try {
        await lstat(join(root, "recovery-state.json"));
        throw stateError();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const admission = await check();
      const initial = {
        version: 1,
        admission,
        sequence: 1,
        phase: "admitted",
        status: "entered",
        backup: null,
      };
      await writePrivateFile(
        root,
        "recovery-state.json",
        Buffer.from(JSON.stringify(initial) + "\n"),
      );
      state = initial;
    });
    const store = Object.freeze({
      read: () => guarded(() => snapshot(state)),
      produceBackup: (producer) =>
        guarded(async (capability) => {
          if (
            state.phase !== "backup-verified" ||
            state.status !== "entered" ||
            producerUsed ||
            typeof producer !== "function"
          )
            throw stateError();
          producerUsed = true;
          return producer(capability);
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
          if (state.status !== "entered" || state.phase !== phase) throw stateError();
          let backup = state.backup;
          if (phase === "backup-verified") {
            if (proof.length !== 1) throw stateError();
            backup = validateBackup(snapshot(proof[0]), state.admission.identity);
          } else if (proof.length) throw stateError();
          await save({ ...state, sequence: state.sequence + 1, status: "completed", backup });
        }),
    });
    try {
      return await callback(store);
    } catch (error) {
      // An unreaped adapter process may still mutate Docker. Preserve the last
      // durable boundary and let the owning host latch uncertainty before exit.
      if (error?.terminationConfirmed === false || error?.durabilityUncertain === true)
        throw stateError(true);
      // If persistence became uncertain, the host guard rejects this write and
      // retains its lock. Never clear or relabel the uncertain record.
      await guarded(() =>
        save({ ...state, sequence: state.sequence + 1, status: "recovery-required" }),
      ).catch(() => {});
      throw error;
    } finally {
      active = false;
    }
  });
}
