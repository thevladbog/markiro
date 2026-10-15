import type { Db } from "@markiro/db";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { createUnitCompositionProgressEngine } from "./us-dataset-trace-readiness-stage.js";
import type {
  NativeTraceOutput,
  UsDatasetTraceReadinessUnit,
} from "./us-dataset-trace-readiness.js";

export type UsDatasetUnitCompositionResult = NativeTraceOutput;

/** Closed unit owner; only ordinary context and a strict selector enter public methods. */
export class UsDatasetUnitCompositionStore {
  private readonly engine: ReturnType<typeof createUnitCompositionProgressEngine>;
  constructor(db: Db) {
    this.engine = createUnitCompositionProgressEngine(db);
  }
  initialize(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetUnitCompositionResult> {
    return this.engine.initialize(context, unit);
  }
  verify(
    context: UsDatasetContext,
    unit: UsDatasetTraceReadinessUnit,
  ): Promise<UsDatasetUnitCompositionResult> {
    return this.engine.verify(context, unit);
  }
}
