import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type { UsDatasetContext } from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { UsDatasetReferenceSeedStore } from "./us-dataset-reference-seed.js";
import { UsDatasetSpecialSeedStore } from "./us-dataset-special-seed.js";
import { UsDatasetCorrectedTransformationSeedStore } from "./us-dataset-corrected-transformation-seed.js";
import { UsDatasetCorrectedCasesSeedStore } from "./us-dataset-corrected-cases-seed.js";
import { UsDatasetCorrectedShippingSeedStore } from "./us-dataset-corrected-shipping-seed.js";
import { assertBoundedSyntheticJson } from "./us-demo-journal-contract.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export type UsDatasetSpecialChainsResult = Readonly<{
  datasetId: string;
  version: "us-processor-six-month-v1";
  definitionDigest: string;
  state: "special_chains_shipping_verified";
  datasetComplete: false;
  correction: Readonly<{
    unitKey: "correction_0001";
    lifecycleResultDigest: string;
    transformationResultDigest: string;
    casesResultDigest: string;
    shippingResultDigest: string;
    shipmentCount: number;
  }>;
  orphan: Readonly<{
    unitKey: "orphan_0001";
    lifecycleResultDigest: string;
  }>;
}>;

/** Internal ordered composition; native stages retain their own transactions and proof. */
export class UsDatasetSpecialChainsSeedStore {
  private readonly journal: UsDatasetJournalStore;
  private readonly references: UsDatasetReferenceSeedStore;
  private readonly special: UsDatasetSpecialSeedStore;
  private readonly transformation: UsDatasetCorrectedTransformationSeedStore;
  private readonly cases: UsDatasetCorrectedCasesSeedStore;
  private readonly shipping: UsDatasetCorrectedShippingSeedStore;

  constructor(db: Db) {
    this.journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
    this.references = new UsDatasetReferenceSeedStore(db);
    this.special = new UsDatasetSpecialSeedStore(db);
    this.transformation = new UsDatasetCorrectedTransformationSeedStore(db);
    this.cases = new UsDatasetCorrectedCasesSeedStore(db);
    this.shipping = new UsDatasetCorrectedShippingSeedStore(db);
  }
  initialize(context: UsDatasetContext): Promise<UsDatasetSpecialChainsResult> {
    return this.execute(context, "initialize");
  }
  verify(context: UsDatasetContext): Promise<UsDatasetSpecialChainsResult> {
    return this.execute(context, "verify");
  }
  private async execute(
    context: UsDatasetContext,
    mode: "initialize" | "verify",
  ): Promise<UsDatasetSpecialChainsResult> {
    let unitKey = "unknown";
    let stage = "target";
    try {
      await this.journal.read(context);
      unitKey = "references";
      stage = "references";
      await this.references[mode](context);
      const header = await this.journal.read(context);
      if (!header) throw new Error("us_dataset_special_chains_prerequisite_incomplete");
      unitKey = "correction_0001";
      stage = "amend_receiving";
      const correction = await this.special[mode](context, "correction");
      stage = "transformation";
      const transformation = await this.transformation[mode](context);
      stage = "cases";
      const cases = await this.cases[mode](context);
      stage = "shipping";
      const shipping = await this.shipping[mode](context);
      unitKey = "orphan_0001";
      stage = "void_receiving";
      const orphan = await this.special[mode](context, "orphan");
      const summary: UsDatasetSpecialChainsResult = Object.freeze({
        datasetId: header.id,
        version: header.version,
        definitionDigest: header.definitionDigest,
        state: "special_chains_shipping_verified",
        datasetComplete: false,
        correction: Object.freeze({
          unitKey: "correction_0001",
          lifecycleResultDigest: canonicalExportDigest(correction),
          transformationResultDigest: canonicalExportDigest(transformation),
          casesResultDigest: canonicalExportDigest(cases),
          shippingResultDigest: canonicalExportDigest(shipping),
          shipmentCount: shipping.shipments.length,
        }),
        orphan: Object.freeze({
          unitKey: "orphan_0001",
          lifecycleResultDigest: canonicalExportDigest(orphan),
        }),
      });
      assertBoundedSyntheticJson(summary);
      return summary;
    } catch (error) {
      if (error !== null && (typeof error === "object" || typeof error === "function")) {
        for (const [key, value] of [
          ["unitKey", unitKey],
          ["stage", stage],
        ] as const) {
          try {
            if (Object.isExtensible(error) && !(key in error))
              Object.defineProperty(error, key, {
                value,
                enumerable: true,
                configurable: true,
                writable: true,
              });
          } catch {
            /* Annotation is best effort; the original thrown object always escapes. */
          }
        }
      }
      throw error;
    }
  }
}
