import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import type { UsDatasetNativeResult } from "./us-dataset-native-seed.js";
import { makeUsDatasetNativeAssemblyInput } from "./us-dataset-native-assembly-contract.js";
import type { UsDatasetRegularResult } from "./us-dataset-regular-contract.js";
import type { UsDatasetSpecialChainsResult } from "./us-dataset-special-chains-seed.js";
import {
  UsDatasetUnitCompositionStore,
  type UsDatasetUnitCompositionResult,
} from "./us-dataset-unit-composition.js";
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
  private readonly owner: UsDatasetUnitCompositionStore;
  constructor(db: Db) {
    this.owner = new UsDatasetUnitCompositionStore(db);
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
    const units: UsDatasetTraceReadinessSeedResult["units"][number][] = [];
    const chains: UsDatasetRegularResult["chains"][number][] = [];
    let identity:
      | Pick<UsDatasetTraceReadinessSeedResult, "datasetId" | "version" | "definitionDigest">
      | undefined;
    const invalid = (): never => {
      throw new Error("us_dataset_native_assembly_input_invalid");
    };
    const append = (output: UsDatasetUnitCompositionResult, unitKey: string) => {
      const trace = output.trace;
      if (trace.unitKey !== unitKey) invalid();
      if (!identity)
        identity = {
          datasetId: trace.datasetId,
          version: trace.version,
          definitionDigest: trace.definitionDigest,
        };
      else if (
        trace.datasetId !== identity.datasetId ||
        trace.version !== identity.version ||
        trace.definitionDigest !== identity.definitionDigest
      )
        invalid();
      units.push(
        Object.freeze({ unitKey: trace.unitKey, resultDigest: canonicalExportDigest(trace) }),
      );
    };
    for (let index = 0; index < 260; index++) {
      const output = await this.owner[mode](context, { kind: "regular", index });
      if (output.kind !== "regular") return invalid();
      append(output, `chain_${String(index).padStart(4, "0")}`);
      chains.push(output.native);
    }
    const correction = await this.owner[mode](context, { kind: "correction" });
    if (correction.kind !== "correction") return invalid();
    append(correction, "correction_0001");
    const orphan = await this.owner[mode](context, { kind: "orphan" });
    if (orphan.kind !== "orphan") return invalid();
    append(orphan, "orphan_0001");
    if (!identity) return invalid();
    const regularSummary: UsDatasetRegularResult = {
      ...identity,
      range: { startIndex: 0, count: 260 },
      state: "selected_regular_shipping_verified",
      datasetComplete: false,
      chains,
    };
    const specialSummary: UsDatasetSpecialChainsResult = {
      ...identity,
      state: "special_chains_shipping_verified",
      datasetComplete: false,
      correction: correction.native,
      orphan: orphan.native,
    };
    const assembled = makeUsDatasetNativeAssemblyInput(regularSummary, specialSummary);
    const native: UsDatasetNativeResult = Object.freeze({
      ...assembled,
      state: "native_chains_shipping_verified",
    });
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
