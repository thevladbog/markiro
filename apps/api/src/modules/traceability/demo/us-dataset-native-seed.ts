import type { Db } from "@markiro/db";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import {
  makeUsDatasetNativeAssemblyInput,
  type UsDatasetNativeAssemblyInput,
} from "./us-dataset-native-assembly-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { UsDatasetRegularSeedStore } from "./us-dataset-regular-seed.js";
import { UsDatasetSpecialChainsSeedStore } from "./us-dataset-special-chains-seed.js";
import { nativeFailure } from "./us-dataset-native-failure.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetNativeResult = Omit<UsDatasetNativeAssemblyInput, "state"> &
  Readonly<{ state: "native_chains_shipping_verified" }>;

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
