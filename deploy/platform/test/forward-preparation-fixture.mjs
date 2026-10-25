import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { productionFixture } from "./production-activation-fixture.mjs";
import { upgradeFixture } from "./upgrade-fixture.mjs";
import { forwardFixture, forwardPrepared } from "./forward-fixture.mjs";
import { forwardStateFixture } from "./forward-state-fixture.mjs";
import { withHeldForwardState } from "../host/forward-state.mjs";
export async function forwardPreparationFixture(t, failAt) {
  const p = await productionFixture(t, { nested: true });
  const failedIdentity = {
    ...structuredClone(p.identity),
    operationId: randomUUID(),
    executorSha: "c".repeat(40),
  };
  const u = upgradeFixture({ root: p.root, identity: failedIdentity });
  const base = forwardFixture({ root: p.root, upgrade: u, newIdentity: p.identity });
  base.now = Date.now();
  base.input.expiresAt = new Date(base.now + 1800000).toISOString();
  const f = await forwardStateFixture(t, {}, { ...base, root: p.root });
  const directory = join(
    dirname(f.root),
    "upgrade-operations",
    f.input.identity.operationId,
    "post-migration-prepare",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const trace = [],
    source = forwardPrepared(f).sourceRuntime;
  let inspections = 0;
  const held = (name, context, cap, action) =>
    withHeldForwardState(cap, async (state) => {
      trace.push(name);
      if (name === failAt) throw new Error("PRIVATE-PREPARE-FAILURE");
      return action(state);
    });
  const adapters = {
    verifyAdmission: (context, cap) =>
      held("verifyAdmission", context, cap, () => f.input.identity),
    inspectSource: (context, cap) =>
      held("inspectSource", context, cap, () => {
        const value = structuredClone(source);
        inspections++;
        if (failAt === `source-${inspections}`) value.schema.schemaSha256 = "f".repeat(64);
        return value;
      }),
    inspectSchema: (context, cap) =>
      held("inspectSchema", context, cap, () => ({
        version: 1,
        kind: "platform-forward-migration-observation",
        postgresId: f.input.baseline.containers.postgres,
        productProofSha256: f.productMigrationProof.proofSha256,
        schema: f.input.baseline.schema,
        rows: f.productMigrationProof.entries.map(({ hash, createdAt }) => ({ hash, createdAt })),
      })),
    createBackup: (context, cap) =>
      held("createBackup", context, cap, (state) => {
        if (state.state.phase !== "backup-verified" || state.state.sequence !== 5)
          throw new Error("wrong producer phase");
        return { backup: p.backup, restoreEvidence: p.restoreEvidence, fence: p.record.fence };
      }),
  };
  return {
    ...f,
    p,
    directory,
    trace,
    adapters,
    context: { root: f.root, admission: f.input, configuration: p.expected.configuration },
  };
}
