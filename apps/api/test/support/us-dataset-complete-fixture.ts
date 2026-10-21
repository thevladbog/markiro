import { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";
import { createUsRequestPlanFixture } from "./us-request-plan-fixture";
import { createUsRequestWorkerStorageFixture } from "./us-request-worker-storage-fixture";
import { createSyntheticUsRequestExecutionIdentity } from "../../src/modules/traceability/requests/us-request-worker-execution";
import type { UsDatasetContext } from "../../src/modules/traceability/demo/us-dataset-contract";
import type { UsDatasetRequestServices } from "../../src/modules/traceability/demo/us-dataset-request-contract";

type UsDatasetCompleteFixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>> & {
  context: UsDatasetContext;
  plan: ReturnType<typeof createUsRequestPlanFixture>;
  packages: ReturnType<typeof createUsRequestWorkerStorageFixture>;
  services: UsDatasetRequestServices;
  writes(): {
    plan: { command: string; key: string }[];
    packages: { kind: "put" | "get" | "head" | "delete"; key: string | undefined }[];
  };
};

/** Fresh owned installation; no native stage, Plan or Request is pre-populated. */
export async function createUsDatasetCompleteFixture(
  base: string,
): Promise<UsDatasetCompleteFixture> {
  const f = await createUsDatasetJournalFixture(base);
  try {
    const context = await f.provision();
    const plan = createUsRequestPlanFixture(f.db, {
      tenant: context.tenantId,
      actor: context.actorUserId,
    });
    const packages = createUsRequestWorkerStorageFixture();
    const execution = createSyntheticUsRequestExecutionIdentity(
      { apiVersion: "us-dataset-complete-test", gitSha: "a".repeat(40), dirty: false },
      { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
    );
    return {
      ...f,
      context,
      plan,
      packages,
      services: { planArtifacts: plan.artifacts, packageArtifacts: packages.store, execution },
      writes: () => ({
        plan: plan.transport.calls.filter(
          ({ command }) => command === "PutObjectCommand" || command === "DeleteObjectCommand",
        ),
        packages: packages.calls
          .filter(({ kind }) => kind === "put" || kind === "delete")
          .map(({ kind, command }) => ({ kind, key: command.input.Key })),
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
