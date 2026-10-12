import type { Db } from "@markiro/db";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import {
  makeUsDatasetNativeAssemblyInput,
  type UsDatasetNativeAssemblyInput,
} from "./us-dataset-native-assembly-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { UsDatasetRegularSeedStore } from "./us-dataset-regular-seed.js";
import { UsDatasetSpecialChainsSeedStore } from "./us-dataset-special-chains-seed.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetNativeResult = Omit<UsDatasetNativeAssemblyInput, "state"> &
  Readonly<{ state: "native_chains_shipping_verified" }>;

const semanticMismatches = new Set([
  "us_dataset_reference_mismatch",
  "us_dataset_receiving_mismatch",
  "us_dataset_transformation_mismatch",
  "us_dataset_cases_mismatch",
  "us_dataset_shipping_mismatch",
  "us_dataset_special_mismatch",
  "us_dataset_corrected_transformation_mismatch",
]);

/** Only a proved domain error may change namespace; ambiguous causes pass through. */
function nativeFailure(error: unknown): unknown {
  try {
    if (!(error instanceof Error) || Object.isFrozen(error)) return error;
    const message = Object.getOwnPropertyDescriptor(error, "message");
    if (
      !message ||
      !("value" in message) ||
      typeof message.value !== "string" ||
      !semanticMismatches.has(message.value)
    )
      return error;
    const annotations: PropertyDescriptorMap = {};
    for (const key of ["unitKey", "stage"]) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (descriptor) {
        if (!("value" in descriptor)) return error;
        annotations[key] = descriptor;
      } else if (key in error) return error;
    }
    const seen = new Set<object>();
    let current: unknown = error;
    for (let depth = 0; current !== undefined && current !== null; depth++) {
      if (typeof current !== "object" || depth >= 32 || seen.has(current)) return error;
      seen.add(current);
      // Any driver/network code, including an inherited/accessor one, prevents translation.
      if ("code" in current) return error;
      const cause = Object.getOwnPropertyDescriptor(current, "cause");
      if (!cause) {
        if ("cause" in current) return error;
        break;
      }
      if (!("value" in cause)) return error;
      current = cause.value;
    }
    return Object.defineProperties(
      new Error("us_dataset_native_drift", { cause: error }),
      annotations,
    );
  } catch {
    // Reflection on an unusual thrown object must never obscure the original failure.
    return error;
  }
}

/** Internal sequential execution; constituent stores own transactions and native proof. */
export class UsDatasetNativeSeedStore {
  private readonly journal: UsDatasetJournalStore;
  private readonly regular: UsDatasetRegularSeedStore;
  private readonly special: UsDatasetSpecialChainsSeedStore;

  constructor(db: Db) {
    this.journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
    this.regular = new UsDatasetRegularSeedStore(db);
    this.special = new UsDatasetSpecialChainsSeedStore(db);
  }
  initialize(context: UsDatasetContext): Promise<UsDatasetNativeResult> {
    return this.execute(context, "initialize");
  }
  verify(context: UsDatasetContext): Promise<UsDatasetNativeResult> {
    return this.execute(context, "verify");
  }
  private async execute(
    context: UsDatasetContext,
    mode: "initialize" | "verify",
  ): Promise<UsDatasetNativeResult> {
    try {
      await this.journal.read(context);
      const regular = await this.regular[mode](context, { startIndex: 0, count: 260 });
      const special = await this.special[mode](context);
      const assembled = makeUsDatasetNativeAssemblyInput(regular, special);
      return Object.freeze({ ...assembled, state: "native_chains_shipping_verified" as const });
    } catch (error) {
      throw nativeFailure(error);
    }
  }
}
