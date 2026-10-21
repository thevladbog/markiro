import type { Db } from "@markiro/db";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type { UsDatasetRequestServices } from "./us-dataset-request-contract.js";
import {
  UsDatasetTraceReadinessSeedStore,
  type UsDatasetTraceReadinessSeedResult,
} from "./us-dataset-trace-readiness-seed.js";
import {
  UsDatasetArtifactSeedStore,
  type UsDatasetArtifactResult,
} from "./us-dataset-artifact-seed.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { usSixMonthDefinition, usSixMonthRequestSelections } from "./us-six-month-definition.js";

export type UsDatasetCompleteSeedResult = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  state: "six_month_seed_stages_verified";
  datasetComplete: false;
  trace: UsDatasetTraceReadinessSeedResult;
  artifacts: UsDatasetArtifactResult;
}>;

function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Sequential actual owners; this is neither atomic state nor viewer acceptance. */
export class UsDatasetCompleteSeedStore {
  private readonly trace: UsDatasetTraceReadinessSeedStore;
  private readonly artifacts: UsDatasetArtifactSeedStore;
  constructor(db: Db, services: UsDatasetRequestServices) {
    this.trace = new UsDatasetTraceReadinessSeedStore(db);
    this.artifacts = new UsDatasetArtifactSeedStore(db, services);
  }
  initialize(context: UsDatasetContext): Promise<UsDatasetCompleteSeedResult> {
    return this.execute(context, "initialize");
  }
  verify(context: UsDatasetContext): Promise<UsDatasetCompleteSeedResult> {
    return this.execute(context, "verify");
  }
  private async execute(
    context: UsDatasetContext,
    mode: "initialize" | "verify",
  ): Promise<UsDatasetCompleteSeedResult> {
    const trace = await this.trace[mode](context);
    const artifacts = await this.artifacts[mode](context);
    const result: UsDatasetCompleteSeedResult = {
      datasetId: trace.datasetId,
      version: trace.version,
      definitionDigest: trace.definitionDigest,
      state: "six_month_seed_stages_verified",
      datasetComplete: false,
      trace,
      artifacts,
    };
    assertBoundedSyntheticJson(result);
    const invalid = (): never => {
      throw new Error("us_dataset_complete_seed_conflict");
    };
    for (const value of [
      trace,
      trace.native,
      trace.native.regular,
      trace.native.special,
      artifacts,
      artifacts.plan,
      ...artifacts.requests,
    ]) {
      if (
        value.datasetId !== result.datasetId ||
        value.version !== usSixMonthDefinition.version ||
        value.definitionDigest !== usSixMonthDefinition.digest ||
        value.datasetComplete !== false
      )
        invalid();
    }
    const unitKeys = [
      ...Array.from({ length: 260 }, (_, index) => `chain_${String(index).padStart(4, "0")}`),
      "correction_0001",
      "orphan_0001",
    ];
    if (
      trace.units.length !== unitKeys.length ||
      trace.units.some((unit, index) => unit.unitKey !== unitKeys[index]) ||
      artifacts.requests.length !== usSixMonthRequestSelections.length ||
      artifacts.requests.some(
        (request, index) =>
          request.unitKey !== usSixMonthRequestSelections[index]?.unitKey ||
          request.plan.id !== artifacts.plan.plan.id ||
          request.plan.sha256 !== artifacts.plan.artifact.sha256,
      )
    )
      invalid();
    return freezeOwned(result);
  }
}
