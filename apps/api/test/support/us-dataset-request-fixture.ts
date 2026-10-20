import { UsDatasetRegularSeedStore } from "../../src/modules/traceability/demo/us-dataset-regular-seed";
import { UsDatasetPlanSeedStore } from "../../src/modules/traceability/demo/us-dataset-plan-seed";
import { createSyntheticUsRequestExecutionIdentity } from "../../src/modules/traceability/requests/us-request-worker-execution";
import { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";
import { createUsRequestPlanFixture } from "./us-request-plan-fixture";
import { createUsRequestWorkerStorageFixture } from "./us-request-worker-storage-fixture";
import type { UsDatasetRequestServices } from "../../src/modules/traceability/demo/us-dataset-request-contract";
import type { UsDatasetPlanResult } from "../../src/modules/traceability/demo/us-dataset-plan-contract";
import type { UsDatasetContext } from "../../src/modules/traceability/demo/us-dataset-contract";

export type UsDatasetRequestFixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>> & {
  context: UsDatasetContext;
  plan: ReturnType<typeof createUsRequestPlanFixture>;
  packages: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  ownedPlan: UsDatasetPlanResult;
  services: UsDatasetRequestServices;
  writes(): {
    plan: { command: string; key: string }[];
    packages: ReturnType<typeof createUsRequestWorkerStorageFixture>["calls"];
  };
};

/** Owns native synthetic prerequisites; only the private provider transport is local. */
export async function createUsDatasetRequestFixture(
  base: string,
): Promise<UsDatasetRequestFixture> {
  const f = await createUsDatasetJournalFixture(base);
  try {
    const context = await f.provision();
    const plan = createUsRequestPlanFixture(f.db, {
      tenant: context.tenantId,
      actor: context.actorUserId,
    });
    const packages = createUsRequestWorkerStorageFixture();
    const execution = createSyntheticUsRequestExecutionIdentity(
      { apiVersion: "us-dataset-request-test", gitSha: "a".repeat(40), dirty: false },
      { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
    );
    await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 259, count: 1 });
    const ownedPlan = await new UsDatasetPlanSeedStore(f.db, plan.artifacts).initialize(context);
    return {
      ...f,
      context,
      plan,
      packages,
      ownedPlan,
      services: { planArtifacts: plan.artifacts, packageArtifacts: packages.store, execution },
      writes: () => ({
        plan: plan.transport.calls.filter(({ command }) => command !== "GetObjectCommand"),
        packages: packages.calls.filter(({ kind }) => kind === "put" || kind === "delete"),
      }),
      async close() {
        packages.destroy();
        plan.destroy();
        await f.close();
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
