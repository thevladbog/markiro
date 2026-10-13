import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { UsDatasetNativeSeedStore, type UsDatasetNativeResult } from "./us-dataset-native-seed.js";
import { UsDatasetTraceReadinessStageStore } from "./us-dataset-trace-readiness-stage.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";

export type UsDatasetTraceReadinessSeedResult = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  state: "native_chains_trace_readiness_verified";
  datasetComplete: false;
  native: UsDatasetNativeResult;
  units: readonly Readonly<{ unitKey: string; resultDigest: string }>[];
}>;

/** Full sequential composition; committed progress survives the original failing operation. */
export class UsDatasetTraceReadinessSeedStore {
  private readonly native: UsDatasetNativeSeedStore;
  private readonly stage: UsDatasetTraceReadinessStageStore;
  constructor(db: Db) {
    this.native = new UsDatasetNativeSeedStore(db);
    this.stage = new UsDatasetTraceReadinessStageStore(db);
  }
  initialize(context: UsDatasetContext): Promise<UsDatasetTraceReadinessSeedResult> {
    return this.execute(context, "initialize");
  }
  verify(context: UsDatasetContext): Promise<UsDatasetTraceReadinessSeedResult> {
    return this.execute(context, "verify");
  }
  private async execute(
    context: UsDatasetContext,
    mode: "initialize" | "verify",
  ): Promise<UsDatasetTraceReadinessSeedResult> {
    const native = await this.native[mode](context);
    const units: UsDatasetTraceReadinessSeedResult["units"][number][] = [];
    for (let index = 0; index < 260; index++) {
      const result = await this.stage[mode](context, { kind: "regular", index });
      units.push(
        Object.freeze({ unitKey: result.unitKey, resultDigest: canonicalExportDigest(result) }),
      );
    }
    for (const kind of ["correction", "orphan"] as const) {
      const result = await this.stage[mode](context, { kind });
      units.push(
        Object.freeze({ unitKey: result.unitKey, resultDigest: canonicalExportDigest(result) }),
      );
    }
    const result: UsDatasetTraceReadinessSeedResult = Object.freeze({
      datasetId: native.datasetId,
      version: native.version,
      definitionDigest: native.definitionDigest,
      state: "native_chains_trace_readiness_verified",
      datasetComplete: false,
      native,
      units: Object.freeze(units),
    });
    assertBoundedSyntheticJson(result);
    return result;
  }
}
