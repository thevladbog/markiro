import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  assertPrivateRoot,
  readPrivateFile,
  syncPrivateDirectory,
  writePrivateFile,
} from "./files.mjs";
import {
  phases,
  sameTarget,
  snapshot,
  stateError,
  validateBackup,
  validateIdentity,
  validateState,
} from "./state-validation.mjs";

const heldCapabilities = new WeakMap();

// A token can only originate inside an active guarded persistence call. It is
// single-use and cannot be serialized into an operation or retained for later.
export async function withHeldHostState(capability, callback) {
  const held = heldCapabilities.get(capability);
  if (!held || held.used || typeof callback !== "function") throw stateError();
  held.used = true;
  const result = Promise.resolve().then(() => callback(held.read()));
  held.pending = result;
  result.catch(() => {});
  return result;
}

async function releaseOwnLock(root, lockPath, owned) {
  const actual = await lstat(lockPath);
  if (actual.dev !== owned.dev || actual.ino !== owned.ino) throw lockReleaseError();
  await unlink(lockPath);
  // Journal writes are already drained and durable, and the store has expired.
  // A successor may acquire/sync after unlink; never restore or alter its lock.
  await syncPrivateDirectory(root);
}

function lockReleaseError() {
  const error = new Error("Host deployment lock retirement failed.");
  error.code = "ERR_HOST_LOCK_RELEASE";
  error.durabilityUncertain = false;
  error.lockRetirementUncertain = true;
  return error;
}

// Lock names are deliberately fixed. The private root and cooperating operators
// are the trust boundary, not protection against hostile root/current-UID peers.
export async function withHostState(root, callback) {
  let lock;
  let owned;
  let uncertain = false;
  let active = true;
  let busy = false;
  let pending;
  let outcome;
  let failure;
  let retirementFailed = false;
  const lockPath = join(typeof root === "string" ? root : "", ".deploy.lock");
  const latch = (error) => {
    uncertain ||= error?.durabilityUncertain === true;
    return stateError(uncertain);
  };
  try {
    await assertPrivateRoot(root);
    if (typeof callback !== "function") throw stateError();
    lock = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    // Once a lock exists, failures before its durable publication must retain it.
    uncertain = true;
    owned = await lock.stat();
    if (
      !owned.isFile() ||
      owned.nlink !== 1 ||
      owned.uid !== process.getuid() ||
      (owned.mode & 0o7777) !== 0o600
    )
      throw stateError(true);
    await lock.writeFile(`${randomUUID()}\n`);
    await lock.sync();
    await syncPrivateDirectory(root);
    uncertain = false;
    let state = { version: 1, sequence: 0, current: null, previousHealthy: null };
    try {
      await lstat(join(root, "state.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw stateError();
      state = null;
    }
    state =
      state === null
        ? { version: 1, sequence: 0, current: null, previousHealthy: null }
        : validateState(JSON.parse((await readPrivateFile(root, "state.json")).toString("utf8")));

    function run(operation) {
      if (!active || busy || uncertain) return Promise.reject(stateError(uncertain));
      busy = true;
      const result = (async () => {
        try {
          return await operation();
        } catch (error) {
          throw latch(error);
        } finally {
          busy = false;
        }
      })();
      pending = result;
      // A callback may launch without awaiting. The owner still drains it before
      // releasing the lock; this handler also prevents an unhandled rejection.
      result.catch(() => {});
      return result;
    }
    async function save(next) {
      next.sequence = state.sequence + 1;
      validateState(next);
      await writePrivateFile(root, "state.json", Buffer.from(JSON.stringify(next) + "\n"), {
        replace: true,
      });
      state = next;
    }
    const store = Object.freeze({
      // Trusted recovery persistence shares this owner's lifetime and durability
      // latch. Even a caught sidecar failure must retain the deployment lock.
      guardPersistence: (action) =>
        run(async () => {
          if (typeof action !== "function") throw stateError();
          const capability = Object.freeze({});
          const held = {
            used: false,
            pending: undefined,
            read: () => ({ root, state: snapshot(state) }),
          };
          heldCapabilities.set(capability, held);
          try {
            return await action(capability);
          } catch (error) {
            // Preserve uncertainty before draining a producer that may fail too.
            throw latch(error);
          } finally {
            heldCapabilities.delete(capability);
            // Drain even a producer whose caller forgot to await it. Errors
            // pass through run's durability latch before lock retirement.
            await held.pending;
          }
        }),
      read: () => run(() => structuredClone(validateState(state))),
      begin: (input) =>
        run(async () => {
          const identity = validateIdentity(snapshot(input));
          const prior = state.current;
          if (
            prior &&
            (prior.phase !== "healthy" ||
              prior.status !== "completed" ||
              prior.identity.operationId === identity.operationId ||
              !sameTarget(prior.identity.target, identity.target))
          )
            throw stateError();
          if (state.previousHealthy?.identity.operationId === identity.operationId)
            throw stateError();
          await save({
            version: 1,
            sequence: state.sequence,
            current: { identity, phase: "admitted", status: "entered", backup: null },
            previousHealthy: prior,
          });
        }),
      enter: (phase) =>
        run(async () => {
          const current = state.current;
          if (
            !current ||
            current.status !== "completed" ||
            phases.indexOf(phase) !== phases.indexOf(current.phase) + 1 ||
            !phases.includes(phase)
          )
            throw stateError();
          if (phase === "migrating") validateBackup(current.backup, current.identity);
          await save({ ...state, current: { ...current, phase, status: "entered" } });
        }),
      complete: (phase, ...proof) =>
        run(async () => {
          const current = state.current;
          if (!current || current.status !== "entered" || current.phase !== phase)
            throw stateError();
          let backup = current.backup;
          if (phase === "backup-verified") {
            if (proof.length !== 1) throw stateError();
            backup = validateBackup(snapshot(proof[0]), current.identity);
          } else if (proof.length) throw stateError();
          await save({ ...state, current: { ...current, status: "completed", backup } });
        }),
      fail: () =>
        run(async () => {
          const current = state.current;
          if (
            !current ||
            current.status === "recovery-required" ||
            (current.phase === "healthy" && current.status === "completed")
          )
            throw stateError();
          await save({ ...state, current: { ...current, status: "recovery-required" } });
        }),
    });
    let callbackError;
    try {
      outcome = await callback(store);
    } catch (error) {
      callbackError = latch(error);
    } finally {
      active = false;
      await pending?.catch(() => {});
    }
    if (callbackError || uncertain) throw stateError(uncertain);
  } catch (error) {
    failure = latch(error);
  } finally {
    active = false;
    if (lock) {
      try {
        await lock.close();
      } catch {
        retirementFailed = true;
      }
    }
    if (owned && !uncertain && !retirementFailed) {
      try {
        await releaseOwnLock(root, lockPath, owned);
      } catch {
        retirementFailed = true;
      }
    }
  }
  if (uncertain) throw stateError(true);
  if (retirementFailed) throw lockReleaseError();
  if (failure) throw failure;
  return outcome;
}
