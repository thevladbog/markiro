const methods = [
  "verifyBefore",
  "checkpoint",
  "apply",
  "inspectCandidate",
  "verifyAfter",
  "suggestions",
  "accept",
  "restoreBefore",
  "inspectRestored",
];
const flags = ["terminationConfirmed", "durabilityUncertain", "restored", "recoveryRequired"];

function sanitizedFailure(stage, ...causes) {
  const error = new Error("Configuration lifecycle failed.");
  error.code = "CONFIGURATION_LIFECYCLE_FAILED";
  error.stage = stage;
  for (const cause of causes) {
    for (const flag of flags) {
      const value = cause?.[flag];
      if (typeof value !== "boolean") continue;
      // Unconfirmed termination and uncertain durability cannot be cleared by
      // a later failure reporting a more reassuring outcome.
      if (flag === "terminationConfirmed") error[flag] = error[flag] !== false && value;
      else error[flag] = error[flag] === true || value;
    }
  }
  return error;
}

function uncertain(outcome) {
  return outcome?.terminationConfirmed === false || outcome?.durabilityUncertain === true;
}

/**
 * Caller holds the canonical host lock. Adapters are fixed, trusted installed
 * code: they own inventory/identity checks, durable journal writes and external
 * operations. This lifecycle never retries a mutation or emits child diagnostics.
 */
export async function runConfigurationLifecycle(adapters) {
  let stage = "adapters";
  let applyStarted = false;
  const perform = async (nextStage, method, ...args) => {
    stage = nextStage;
    const result = await adapters[method](...args);
    // Side effects must not report an explicitly unknown outcome as success.
    // Acceptance returns its opaque receipt; its host adapter must throw on any
    // persistence ambiguity so an already accepted target is never rolled back.
    if (method !== "accept" && uncertain(result)) throw result;
    return result;
  };

  try {
    if (methods.some((method) => typeof adapters?.[method] !== "function"))
      throw sanitizedFailure(stage);
    await perform("verify-before", "verifyBefore");
    await perform("admitted", "checkpoint", "admitted");
    await perform("applying", "checkpoint", "applying");
    // A failed applying checkpoint cannot authorize either mutation or restore.
    applyStarted = true;
    await perform("apply", "apply");
    const current = await perform("inspect-candidate", "inspectCandidate");
    await perform("api-replaced", "checkpoint", "api-replaced", current);
    await perform("verify-after", "verifyAfter");
    await perform("suggestions", "suggestions");
    await perform("verified", "checkpoint", "verified", current);
    return await perform("accept-healthy", "accept", "healthy", current);
  } catch (cause) {
    const error = sanitizedFailure(stage, cause);
    if (uncertain(error)) {
      error.recoveryRequired = true;
      throw error;
    }
    if (!applyStarted) throw error;

    try {
      await perform("returning-old", "checkpoint", "returning-old");
      await perform("restore-before", "restoreBefore");
      const current = await perform("inspect-restored", "inspectRestored");
      await perform("verify-restored", "verifyAfter");
      await perform("returned-old", "checkpoint", "returned-old", current);
      await perform("accept-returned-old", "accept", "returned-old", current);
    } catch (recoveryCause) {
      const recoveryError = sanitizedFailure(stage, error, recoveryCause);
      recoveryError.recoveryRequired = true;
      throw recoveryError;
    }
    // The old environment has a newly created container ID, now recorded by the
    // terminal receipt. Suggestions are deliberately not retried on old config.
    error.restored = true;
    throw error;
  }
}
