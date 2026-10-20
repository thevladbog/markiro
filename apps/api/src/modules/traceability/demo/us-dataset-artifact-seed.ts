import type { Db } from "@markiro/db";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type { UsDatasetPlanResult } from "./us-dataset-plan-contract.js";
import type {
  UsDatasetRequestResult,
  UsDatasetRequestServices,
} from "./us-dataset-request-contract.js";
import { UsDatasetPlanSeedStore } from "./us-dataset-plan-seed.js";
import { UsDatasetRequestSeedStore } from "./us-dataset-request-seed.js";
import { usSixMonthRequestSelections } from "./us-six-month-definition.js";

export type UsDatasetArtifactResult = Readonly<{
  datasetId: UsDatasetPlanResult["datasetId"];
  version: UsDatasetPlanResult["version"];
  definitionDigest: UsDatasetPlanResult["definitionDigest"];
  state: "plan_request_artifacts_verified";
  datasetComplete: false;
  plan: UsDatasetPlanResult;
  requests: readonly UsDatasetRequestResult[];
}>;

/** Compose owned artifacts only; native chain prerequisites remain independently owned. */
export class UsDatasetArtifactSeedStore {
  private readonly plan: UsDatasetPlanSeedStore;
  private readonly requests: UsDatasetRequestSeedStore;

  constructor(db: Db, services: UsDatasetRequestServices) {
    this.plan = new UsDatasetPlanSeedStore(db, services.planArtifacts);
    this.requests = new UsDatasetRequestSeedStore(db, services);
  }

  initialize(context: UsDatasetContext): Promise<UsDatasetArtifactResult> {
    return this.execute(context, "initialize");
  }

  verify(context: UsDatasetContext): Promise<UsDatasetArtifactResult> {
    return this.execute(context, "verify");
  }

  private async execute(context: UsDatasetContext, mode: "initialize" | "verify") {
    const plan = await this.plan[mode](context);
    const requests: UsDatasetRequestResult[] = [];
    for (const { unitKey } of usSixMonthRequestSelections) {
      requests.push(await this.requests[mode](context, unitKey));
    }
    return Object.freeze({
      datasetId: plan.datasetId,
      version: plan.version,
      definitionDigest: plan.definitionDigest,
      state: "plan_request_artifacts_verified" as const,
      datasetComplete: false as const,
      plan,
      requests: Object.freeze(requests),
    });
  }
}
