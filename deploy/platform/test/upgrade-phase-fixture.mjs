import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withUpgradeState } from "../host/upgrade-state.mjs";
import { privateFixture, backupProof } from "./host-fixtures.mjs";
import {
  upgradeFixture,
  upgradeHash,
  upgradeOldRuntime,
  upgradePreparation,
} from "./upgrade-fixture.mjs";
export async function phaseFixture(t, failurePhase) {
  const { root: parent } = await privateFixture(t);
  const root = join(parent, "state");
  await mkdir(root, { mode: 0o700 });
  const f = upgradeFixture({ root });
  const id = f.input.predecessor.identity.operationId;
  const operation = join(parent, "recovery-operations", id, "activate");
  await mkdir(operation, { recursive: true, mode: 0o700 });
  for (const [name, path] of Object.entries({
    original: join(root, "state.json"),
    acceptedRecovery: join(root, "recovery-state.json"),
    preparation: join(root, "recovery-preparation.json"),
    consumption: join(root, `recovery-activation-${id}.json`),
    activationOperation: join(operation, "operation.json"),
  }))
    await writeFile(path, f.predecessorBytes[name], { mode: 0o600 });
  const prepare = withUpgradeState(
    root,
    f.input,
    async (s) => {
      await s.complete("admitted", upgradeOldRuntime(f.input));
      if (failurePhase === "admitted") throw Error("known failure");
      await s.enter("old-stopped");
      if (failurePhase === "old-stopped") throw Error("known failure");
      await s.complete("old-stopped");
      await s.enter("backup-verified");
      if (failurePhase === "backup-verified") throw Error("known failure");
      await s.complete(
        "backup-verified",
        backupProof(f.input.identity),
        upgradePreparation(f.input),
      );
    },
    { now: () => f.now },
  );
  if (failurePhase) await assert.rejects(prepare);
  else await prepare;
  const directory = join(root, "upgrade-operations", f.input.identity.operationId);
  const journal = join(directory, "state.json");
  const phaseInput = async (phase, now = f.now + 3600000) => {
    const priorBytes = await readFile(journal);
    const prior = JSON.parse(priorBytes);
    return {
      version: 1,
      kind: "platform-upgrade-phase",
      phase,
      identity: f.input.identity,
      prior: { sequence: prior.sequence, sha256: upgradeHash(priorBytes) },
      executorCi: f.input.executorCi,
      reviewedPlanSha256: f.input.reviewedPlanSha256,
      dispatch: {
        toolingSha: f.input.identity.executorSha,
        runId: phase === "activate" ? "987654323" : "987654324",
        runAttempt: "1",
      },
      expiresAt: new Date(now + 1800000).toISOString(),
    };
  };
  return { ...f, root, directory, journal, phaseInput, phaseNow: f.now + 3600000 };
}
