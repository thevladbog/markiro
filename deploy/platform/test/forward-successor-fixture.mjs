import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forwardCommandFixture } from "./forward-command-fixture.mjs";
import { withForwardPreparationState } from "../host/forward-state.mjs";
import { sanitizeHostFailure } from "../host/failure-diagnostic.mjs";
import { digest } from "../backup/schemas.mjs";
import { readFailedForwardPredecessor } from "../host/forward-successor-admission.mjs";
export async function forwardSuccessorFixture(t, fixtureOptions) {
  const f = await forwardCommandFixture(t, fixtureOptions);
  const prior = structuredClone(f.input),
    id = prior.identity.operationId;
  const injected = new Error("synthetic admission read failure");
  await assert.rejects(
    withForwardPreparationState(
      f.root,
      prior,
      async () => {
        throw injected;
      },
      {
        now: () => Date.now(),
        productMigrationProof: f.productMigrationProof,
        verifyBaseline: async () => {},
        renameIndex: async ({ root, destination, checkpoint }) => {
          const { rename } = await import("node:fs/promises");
          const { forwardMetadata } = await import("./forward-state-fixture.mjs");
          await checkpoint("before-rename");
          await rename(join(root, "upgrade-index.json"), join(root, destination));
          await checkpoint("after-rename");
          return forwardMetadata(join(root, destination));
        },
      },
    ),
    (e) => e.code === "ERR_HOST_STATE" && e.durabilityUncertain === false,
  );
  const encode = (v) => Buffer.from(`${JSON.stringify(v)}\n`);
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, Buffer.isBuffer(value) ? value : encode(value), { mode: 0o600 });
  };
  await put(
    join(f.directory, "failure.json"),
    sanitizeHostFailure(injected, {
      operationId: id,
      phase: "admitted",
      boundary: "verifyAdmission",
      commandCategory: "validation",
    }),
  );
  const marker = {
    version: 1,
    phase: prior.phase,
    executorSha: prior.identity.executorSha,
    operationId: id,
    dispatch: prior.dispatch,
  };
  await put(join(f.directory, "delivery.json"), {
    phase: prior.phase,
    dispatch: prior.dispatch,
    executorSha: prior.identity.executorSha,
    operationId: id,
    bundleSha256: "d".repeat(64),
  });
  await put(join(f.directory, "execution-fence.json"), marker);
  await put(join(f.directory, "command-started.json"), marker);
  const failedForwardBytes = await readFailedForwardPredecessor(f.root, id);
  const input = {
    ...structuredClone(prior),
    kind: "platform-forward-admission-successor",
    identity: {
      ...structuredClone(prior.identity),
      operationId: "b0e945b0-66bb-4c31-a18b-9976ad998fa9",
      executorSha: "9".repeat(40),
    },
    executorCi: { runId: "997654320", runAttempt: "1" },
    dispatch: { toolingSha: "9".repeat(40), runId: "997654321", runAttempt: "1" },
    expiresAt: new Date(Date.now() + 1800000).toISOString(),
    priorForward: {
      identity: prior.identity,
      hashes: Object.fromEntries(
        Object.entries(failedForwardBytes).map(([k, v]) => [k, digest(v)]),
      ),
    },
  };
  const failedUpgradeBytes = { ...f.failedBytes, index: failedForwardBytes.predecessorIndex };
  return {
    ...f,
    input,
    prior,
    failedForwardBytes,
    failedUpgradeBytes,
    put,
    encode,
    now: Date.now(),
    refresh: () => readFailedForwardPredecessor(f.root, id),
    read: (relative) => readFile(join(f.root, relative)),
  };
}
