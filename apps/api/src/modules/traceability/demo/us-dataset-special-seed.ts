import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";

import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsLotStore } from "../lots/us-lot-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { UsReceivingStore } from "../receiving/us-receiving-store.js";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetStageRow,
} from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import { applyUsDatasetSpecial } from "./us-dataset-special-apply.js";
import {
  datasetSpecialError,
  makeUsDatasetSpecialInput,
  makeUsDatasetSpecialStageIdentity,
  parseUsDatasetSpecialResult,
  type UsDatasetSpecialKind,
  type UsDatasetSpecialInput,
  type UsDatasetSpecialLifecycleResult,
  type UsDatasetSpecialReceivingResult,
} from "./us-dataset-special-contract.js";
import {
  verifyUsDatasetSpecial,
  type UsDatasetSpecialStores,
} from "./us-dataset-special-verify.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

const same = (a: unknown, b: unknown) => canonicalExportEqual(a, b);
/** Internal executor; existing references and original ownership are prerequisites. */
export class UsDatasetSpecialSeedStore {
  private readonly stores: UsDatasetSpecialStores;
  constructor(db: Db) {
    this.stores = {
      journal: new UsDatasetJournalStore(db, usSixMonthDefinition),
      master: new UsMasterDataStore(db),
      catalog: new UsCatalogStore(db),
      profiles: new UsProductProfileStore(db),
      documents: new UsReferenceDocumentStore(db),
      lots: new UsLotStore(db),
      receiving: new UsReceivingStore(db),
    };
  }
  async initializeReceiving(
    context: UsDatasetContext,
    kind: UsDatasetSpecialKind,
  ): Promise<UsDatasetSpecialReceivingResult> {
    const result = await this.execute(context, kind, false, true);
    if (result.stage !== "receiving") throw new Error("us_dataset_special_result_invalid");
    return result;
  }
  async verifyReceiving(
    context: UsDatasetContext,
    kind: UsDatasetSpecialKind,
  ): Promise<UsDatasetSpecialReceivingResult> {
    const result = await this.execute(context, kind, false, false);
    if (result.stage !== "receiving") throw new Error("us_dataset_special_result_invalid");
    return result;
  }
  async initialize(
    context: UsDatasetContext,
    kind: UsDatasetSpecialKind,
  ): Promise<UsDatasetSpecialLifecycleResult> {
    await this.initializeReceiving(context, kind);
    const result = await this.execute(context, kind, true, true);
    if (result.stage === "receiving") throw new Error("us_dataset_special_result_invalid");
    return result;
  }
  async verify(
    context: UsDatasetContext,
    kind: UsDatasetSpecialKind,
  ): Promise<UsDatasetSpecialLifecycleResult> {
    const result = await this.execute(context, kind, true, false);
    if (result.stage === "receiving") throw new Error("us_dataset_special_result_invalid");
    return result;
  }
  private async execute(
    context: UsDatasetContext,
    kind: UsDatasetSpecialKind,
    lifecycle: boolean,
    capture: boolean,
  ) {
    const journal = this.stores.journal;
    // Authorize target and owner before interpreting even a hostile runtime kind.
    const header = await journal.read(context);
    if (kind !== "correction" && kind !== "orphan")
      throw datasetSpecialError("us_dataset_special_input_invalid", "unknown", "receiving");
    const unit = kind === "correction" ? "correction_0001" : "orphan_0001";
    const name = lifecycle
      ? kind === "correction"
        ? "amend_receiving"
        : "void_receiving"
      : "receiving";
    const incomplete = () =>
      datasetSpecialError("us_dataset_special_prerequisite_incomplete", unit, name);
    if (!header) throw incomplete();
    const references = await journal.readStage(context, header.id, "references", "references");
    if (!references?.receipt) throw incomplete();
    const original = lifecycle
      ? await journal.readStage(context, header.id, unit, "receiving")
      : null;
    if (lifecycle && !original?.receipt) throw incomplete();
    const input = makeUsDatasetSpecialInput(
      kind,
      name,
      makeUsDatasetReferenceIdentity(header.id, references),
      original ? makeUsDatasetSpecialStageIdentity(header.id, original) : null,
    );
    const checked = (row: UsDatasetStageRow | null, expected: UsDatasetSpecialInput) => {
      if (row && (row.unitKey !== unit || row.stage !== name || !same(row.intent.input, expected)))
        throw datasetSpecialError("us_dataset_special_dependency_conflict", unit, name);
      return row;
    };
    let stage = checked(await journal.readStage(context, header.id, unit, name), input);
    if (!stage && capture) {
      const intent: UsDatasetIntent = {
        unitKey: unit,
        stage: name,
        operationKey: randomUUID(),
        input,
        inputDigest: canonicalExportDigest(input),
      };
      try {
        stage = checked(await journal.captureIntent(context, header.id, intent), input);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
          throw error;
        stage = checked(await journal.readStage(context, header.id, unit, name), input);
        if (!stage) throw error;
      }
    }
    if (!stage || (!capture && !stage.receipt)) throw incomplete();
    const completed = await journal.runAtomicStage(
      context,
      header.id,
      stage.revision,
      stage.intent,
      {
        apply: (tx, checkedContext, intent) => {
          if (!capture) throw incomplete();
          return applyUsDatasetSpecial(tx, checkedContext, intent, this.stores);
        },
        verify: (tx, checkedContext, intent, receipt) =>
          verifyUsDatasetSpecial(tx, checkedContext, intent, receipt, this.stores),
      },
    );
    if (!completed.receipt) throw incomplete();
    return parseUsDatasetSpecialResult(completed.receipt.result);
  }
}
