import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import {
  makeUsDatasetRegularIndices,
  parseUsDatasetRegularRange,
  type UsDatasetRegularRange,
  type UsDatasetRegularResult,
} from "./us-dataset-regular-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { UsDatasetReferenceSeedStore } from "./us-dataset-reference-seed.js";
import { UsDatasetReceivingSeedStore } from "./us-dataset-receiving-seed.js";
import { UsDatasetTransformationSeedStore } from "./us-dataset-transformation-seed.js";
import { UsDatasetCasesSeedStore } from "./us-dataset-cases-seed.js";
import { UsDatasetShippingSeedStore } from "./us-dataset-shipping-seed.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { makeUsSixMonthRegularChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

/** Internal selected-chain execution; each native store owns its transaction and proof. */
export class UsDatasetRegularSeedStore {
  private readonly journal: UsDatasetJournalStore;
  private readonly references: UsDatasetReferenceSeedStore;
  private readonly receiving: UsDatasetReceivingSeedStore;
  private readonly transformation: UsDatasetTransformationSeedStore;
  private readonly cases: UsDatasetCasesSeedStore;
  private readonly shipping: UsDatasetShippingSeedStore;

  constructor(db: Db) {
    this.journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
    this.references = new UsDatasetReferenceSeedStore(db);
    this.receiving = new UsDatasetReceivingSeedStore(db);
    this.transformation = new UsDatasetTransformationSeedStore(db);
    this.cases = new UsDatasetCasesSeedStore(db);
    this.shipping = new UsDatasetShippingSeedStore(db);
  }
  initialize(
    context: UsDatasetContext,
    range: UsDatasetRegularRange,
  ): Promise<UsDatasetRegularResult> {
    return this.execute(context, range, "initialize");
  }
  verify(context: UsDatasetContext, range: UsDatasetRegularRange): Promise<UsDatasetRegularResult> {
    return this.execute(context, range, "verify");
  }
  private async execute(
    context: UsDatasetContext,
    range: UsDatasetRegularRange,
    mode: "initialize" | "verify",
  ): Promise<UsDatasetRegularResult> {
    let unitKey = "unknown";
    let stage = "target";
    try {
      await this.journal.read(context);
      stage = "range";
      const selected = parseUsDatasetRegularRange(range);
      const indices = makeUsDatasetRegularIndices(selected);
      unitKey = "references";
      stage = "references";
      await this.references[mode](context);
      const header = await this.journal.read(context);
      if (!header) throw new Error("us_dataset_regular_prerequisite_incomplete");
      const chains: UsDatasetRegularResult["chains"][number][] = [];
      for (const index of indices) {
        unitKey = makeUsSixMonthRegularChain(index).unitKey;
        stage = "receiving";
        const rows = await this.journal.readStageCompletions(
          context,
          header.id,
          (["receiving", "transformation", "cases", "shipping"] as const).map((stage) => ({
            unitKey,
            stage,
          })),
        );
        // Completion selects a path; only the live terminal proof certifies the chain.
        const completed = rows.every((row) => row?.revision === 2 && row.receiptPresent);
        if (!completed) {
          await this.receiving[mode](context, index);
          stage = "transformation";
          await this.transformation[mode](context, index);
          stage = "cases";
          await this.cases[mode](context, index);
        }
        stage = "shipping";
        const checked = await this.shipping[completed ? "verify" : mode](context, index);
        chains.push(
          Object.freeze({
            index,
            unitKey: checked.input.chain.unitKey,
            shipmentCount: checked.shipments.length,
            shippingResultDigest: canonicalExportDigest(checked),
          }),
        );
      }
      const result: UsDatasetRegularResult = Object.freeze({
        datasetId: header.id,
        version: header.version,
        definitionDigest: header.definitionDigest,
        range: selected,
        state: "selected_regular_shipping_verified",
        datasetComplete: false,
        chains: Object.freeze(chains),
      });
      assertBoundedSyntheticJson(result);
      return result;
    } catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) {
        try {
          Object.defineProperties(error, {
            unitKey: { value: unitKey, enumerable: true, configurable: true, writable: true },
            stage: { value: stage, enumerable: true, configurable: true, writable: true },
          });
        } catch {
          /* Preserve original driver/domain identity when annotation is unavailable. */
        }
      }
      throw error;
    }
  }
}
