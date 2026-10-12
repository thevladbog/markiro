import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { eq } from "drizzle-orm";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  UsDatasetContext,
  UsDatasetIntent,
  UsDatasetReceipt,
  UsDatasetStageRow,
} from "./us-dataset-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import {
  datasetReferenceError,
  parseUsDatasetReferenceResult,
  type UsDatasetReferenceResult,
} from "./us-dataset-reference-contract.js";
import {
  verifyUsDatasetReferences,
  type UsDatasetReferenceStores,
} from "./us-dataset-reference-verify.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { makeUsSixMonthCatalogue } from "./us-six-month-references.js";

const catalogue = makeUsSixMonthCatalogue();
const canonicalInput = Object.freeze({
  version: usSixMonthDefinition.version,
  definitionDigest: usSixMonthDefinition.digest,
  catalogue,
});
const canonicalInputDigest = canonicalExportDigest(canonicalInput);
function checkedStage(stage: UsDatasetStageRow | null): UsDatasetStageRow | null {
  if (
    stage &&
    (stage.unitKey !== "references" ||
      stage.stage !== "references" ||
      stage.intent.unitKey !== "references" ||
      stage.intent.stage !== "references" ||
      stage.intent.inputDigest !== canonicalInputDigest ||
      canonicalExportDigest(stage.intent.input) !== canonicalInputDigest)
  )
    throw datasetReferenceError("us_dataset_reference_mismatch");
  return stage;
}
function result(stage: UsDatasetStageRow): UsDatasetReferenceResult {
  if (!stage.receipt) throw datasetReferenceError("us_dataset_references_incomplete");
  return parseUsDatasetReferenceResult(stage.receipt.result);
}

/** Internal bounded shared catalogue installation. No public runtime entry. */
export class UsDatasetReferenceSeedStore {
  private readonly journal: UsDatasetJournalStore;
  private readonly stores: UsDatasetReferenceStores;
  constructor(db: Db) {
    this.journal = new UsDatasetJournalStore(db, usSixMonthDefinition);
    this.stores = {
      master: new UsMasterDataStore(db),
      catalog: new UsCatalogStore(db),
      profiles: new UsProductProfileStore(db),
    };
  }
  async initialize(context: UsDatasetContext): Promise<UsDatasetReferenceResult> {
    const header = await this.journal.initialize(context);
    let stage = checkedStage(
      await this.journal.readStage(context, header.id, "references", "references"),
    );
    if (!stage) {
      const input = canonicalInput;
      const intent: UsDatasetIntent = {
        unitKey: "references",
        stage: "references",
        operationKey: randomUUID(),
        input,
        inputDigest: canonicalInputDigest,
      };
      try {
        stage = checkedStage(await this.journal.captureIntent(context, header.id, intent));
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
          throw error;
        const winner = checkedStage(
          await this.journal.readStage(context, header.id, "references", "references"),
        );
        if (!winner) throw error;
        stage = winner;
      }
    }
    if (!stage) throw datasetReferenceError("us_dataset_references_incomplete");
    return result(
      await this.journal.runAtomicStage(context, header.id, stage.revision, stage.intent, {
        apply: (tx, checked, intent) => this.apply(tx, checked, intent),
        verify: (tx, checked, intent, receipt) =>
          verifyUsDatasetReferences(tx, checked, intent, receipt, this.stores),
      }),
    );
  }
  async verify(context: UsDatasetContext): Promise<UsDatasetReferenceResult> {
    const header = await this.journal.read(context);
    if (!header) throw datasetReferenceError("us_dataset_references_incomplete");
    const stage = checkedStage(
      await this.journal.readStage(context, header.id, "references", "references"),
    );
    if (!stage?.receipt) throw datasetReferenceError("us_dataset_references_incomplete");
    return result(
      await this.journal.runAtomicStage(context, header.id, stage.revision, stage.intent, {
        apply: () => {
          throw datasetReferenceError("us_dataset_references_incomplete");
        },
        verify: (tx, checked, intent, receipt) =>
          verifyUsDatasetReferences(tx, checked, intent, receipt, this.stores),
      }),
    );
  }
  private async apply(
    tx: UsDemoTransaction,
    context: UsDatasetContext,
    intent: UsDatasetIntent,
  ): Promise<UsDatasetReceipt> {
    const { tenantId, actorUserId } = context;
    for (const table of [
      schema.traceabilityParties,
      schema.traceabilityLocations,
      schema.products,
      schema.productTraceabilityProfiles,
      schema.referenceDocuments,
    ] as const) {
      const existing = await tx
        .select({ tenantId: table.tenantId })
        .from(table)
        .where(eq(table.tenantId, tenantId))
        .limit(1);
      if (existing.length) throw datasetReferenceError("us_dataset_reference_conflict");
    }
    const parties = [];
    const locations = [];
    const products = [];
    const profiles = [];
    const partyBindings = [];
    const locationBindings = [];
    const productBindings = [];
    const requestId = intent.operationKey;
    for (const item of catalogue.parties) {
      const party = await this.stores.master.createPartyInTransaction(
        tx,
        tenantId,
        actorUserId,
        item.input,
        requestId,
      );
      parties.push(party);
      partyBindings.push({ key: item.key, id: party.id });
    }
    for (const item of catalogue.locations) {
      const parent = partyBindings.find(({ key }) => key === item.partyKey);
      if (!parent) throw datasetReferenceError("us_dataset_reference_mismatch");
      const location = await this.stores.master.createLocationInTransaction(
        tx,
        tenantId,
        actorUserId,
        { ...item.input, partyId: parent.id },
        requestId,
      );
      locations.push(location);
      locationBindings.push({ key: item.key, id: location.id });
    }
    for (const item of catalogue.products) {
      const product = await this.stores.catalog.createProductInTransaction(
        tx,
        tenantId,
        actorUserId,
        item.input,
        requestId,
      );
      products.push(product);
      productBindings.push({ key: item.key, id: product.id });
      profiles.push(
        await this.stores.profiles.putProfileInTransaction(
          tx,
          tenantId,
          actorUserId,
          product.id,
          item.profile,
          requestId,
        ),
      );
    }
    const value = parseUsDatasetReferenceResult({
      version: usSixMonthDefinition.version,
      definitionDigest: usSixMonthDefinition.digest,
      bindings: { parties: partyBindings, locations: locationBindings, products: productBindings },
      evidence: { parties, locations, products, profiles },
    });
    return {
      recordIds: [
        ...value.bindings.parties,
        ...value.bindings.locations,
        ...value.bindings.products,
      ].map(({ id }) => id),
      resultDigest: canonicalExportDigest(value),
      result: value,
    };
  }
}
