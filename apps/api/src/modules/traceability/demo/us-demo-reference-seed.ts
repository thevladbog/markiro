import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";

import { canonicalExportDigest, canonicalExportJson } from "./us-demo-canonical.js";
import { eq } from "drizzle-orm";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  UsDemoIntent,
  UsDemoJournal,
  UsDemoJournalContext,
  UsDemoReceipt,
} from "./us-demo-journal-contract.js";
import { UsDemoJournalStore } from "./us-demo-journal.js";
import {
  makeUsDemoReferenceRecipe,
  parseUsDemoReferenceResult,
  type UsDemoPartyKey,
  type UsDemoProductKey,
  type UsDemoDocumentKey,
  type UsDemoReferenceRecipe,
  type UsDemoReferenceResult,
} from "./us-demo-reference-recipe.js";
import { verifyUsDemoReferences, type UsDemoReferenceStores } from "./us-demo-reference-verify.js";

function references(journal: UsDemoJournal, recipe: UsDemoReferenceRecipe) {
  const stage = journal.stages.find((item) => item.stage === "references");
  if (
    stage &&
    (stage.intent.inputDigest !== canonicalExportDigest(recipe) ||
      canonicalExportJson(stage.intent.input) !== canonicalExportJson(recipe))
  )
    throw new Error("us_demo_reference_mismatch");
  return stage;
}
function result(journal: UsDemoJournal): UsDemoReferenceResult {
  const receipt = journal.stages.find((stage) => stage.stage === "references")?.receipt;
  if (!receipt) throw new Error("us_demo_references_incomplete");
  return parseUsDemoReferenceResult(receipt.result);
}
function required<K>(ids: ReadonlyMap<K, string>, key: K): string {
  const id = ids.get(key);
  if (!id) throw new Error("us_demo_reference_mismatch");
  return id;
}

/** Internal reference-only orchestration; no startup, transport, environment or shared-base entry. */
export class UsDemoReferenceSeedStore {
  private readonly journal: UsDemoJournalStore;
  private readonly stores: UsDemoReferenceStores;
  constructor(db: Db) {
    this.journal = new UsDemoJournalStore(db);
    this.stores = {
      master: new UsMasterDataStore(db),
      catalog: new UsCatalogStore(db),
      profiles: new UsProductProfileStore(db),
      documents: new UsReferenceDocumentStore(db),
    };
  }

  async initialize(context: UsDemoJournalContext): Promise<UsDemoReferenceResult> {
    const recipe = makeUsDemoReferenceRecipe();
    let journal = await this.journal.initialize(context);
    let stage = references(journal, recipe);
    if (!stage) {
      const intent: UsDemoIntent = {
        stage: "references",
        operationKey: randomUUID(),
        input: recipe,
        inputDigest: canonicalExportDigest(recipe),
      };
      try {
        journal = await this.journal.captureIntent(context, journal.id, journal.revision, intent);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["us_demo_revision_conflict", "us_demo_intent_conflict"].includes(error.message)
        )
          throw error;
        // A concurrent capture may win; guard rereads original-owner provenance before adoption.
        const winner = await this.journal.read(context);
        if (!winner || winner.id !== journal.id || !references(winner, recipe)) throw error;
        journal = winner;
      }
      stage = references(journal, recipe);
    }
    if (!stage) throw new Error("us_demo_references_incomplete");
    const recorded = await this.journal.runAtomicStage(
      context,
      journal.id,
      journal.revision,
      stage.intent,
      {
        apply: (tx, checked, intent) => this.apply(tx, checked, intent, recipe),
        verify: (tx, checked, intent, receipt) =>
          verifyUsDemoReferences(tx, checked, intent, receipt, this.stores),
      },
    );
    return result(recorded);
  }

  async verify(context: UsDemoJournalContext): Promise<UsDemoReferenceResult> {
    const journal = await this.journal.read(context);
    if (!journal) throw new Error("us_demo_references_incomplete");
    const stage = references(journal, makeUsDemoReferenceRecipe());
    if (!stage?.receipt) throw new Error("us_demo_references_incomplete");
    const checked = await this.journal.runAtomicStage(
      context,
      journal.id,
      journal.revision,
      stage.intent,
      {
        apply: () => {
          throw new Error("us_demo_references_incomplete");
        },
        verify: (tx, checkedContext, intent, receipt) =>
          verifyUsDemoReferences(tx, checkedContext, intent, receipt, this.stores),
      },
    );
    return result(checked);
  }

  private async apply(
    tx: UsDemoTransaction,
    context: UsDemoJournalContext,
    intent: UsDemoIntent,
    recipe: UsDemoReferenceRecipe,
  ): Promise<UsDemoReceipt> {
    const { tenantId, actorUserId } = context;
    // Even archived or coincidentally identical unowned references prevent first apply.
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
      if (existing.length > 0) throw new Error("us_demo_reference_collision");
    }
    const requestId = intent.operationKey;
    const parties = [];
    const partyIds = new Map<UsDemoPartyKey, string>();
    for (const item of recipe.parties) {
      const party = await this.stores.master.createPartyInTransaction(
        tx,
        tenantId,
        actorUserId,
        item.input,
        requestId,
      );
      parties.push(party);
      partyIds.set(item.key, party.id);
    }
    const locations = [];
    const locationIds = new Map<UsDemoPartyKey, string>();
    for (const item of recipe.locations) {
      const location = await this.stores.master.createLocationInTransaction(
        tx,
        tenantId,
        actorUserId,
        { ...item.input, partyId: required(partyIds, item.partyKey) },
        requestId,
      );
      locations.push(location);
      locationIds.set(item.key, location.id);
    }
    const products = [];
    const profiles = [];
    const productIds = new Map<UsDemoProductKey, string>();
    for (const item of recipe.products) {
      const product = await this.stores.catalog.createProductInTransaction(
        tx,
        tenantId,
        actorUserId,
        item.input,
        requestId,
      );
      products.push(product);
      productIds.set(item.key, product.id);
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
    const documents = [];
    const documentIds = new Map<UsDemoDocumentKey, string>();
    for (const item of recipe.documents) {
      const document = await this.stores.documents.createDocumentInTransaction(
        tx,
        tenantId,
        actorUserId,
        { ...item.input, partyId: required(partyIds, item.partyKey) },
        requestId,
      );
      documents.push(document);
      documentIds.set(item.key, document.id);
    }
    const value = parseUsDemoReferenceResult({
      recipeVersion: 1,
      bindings: {
        parties: {
          previous_source: required(partyIds, "previous_source"),
          processor: required(partyIds, "processor"),
          recipient: required(partyIds, "recipient"),
        },
        locations: {
          previous_source: required(locationIds, "previous_source"),
          processor: required(locationIds, "processor"),
          recipient: required(locationIds, "recipient"),
        },
        products: {
          inbound: required(productIds, "inbound"),
          output: required(productIds, "output"),
        },
        documents: {
          receiving_asn: required(documentIds, "receiving_asn"),
          receiving_bol: required(documentIds, "receiving_bol"),
          transformation_work_order: required(documentIds, "transformation_work_order"),
          transformation_batch: required(documentIds, "transformation_batch"),
          shipping_bol: required(documentIds, "shipping_bol"),
          shipping_invoice: required(documentIds, "shipping_invoice"),
        },
      },
      evidence: { parties, locations, products, profiles, documents },
    });
    return {
      recordIds: [...parties, ...locations, ...products, ...documents].map((record) => record.id),
      result: value,
      resultDigest: canonicalExportDigest(value),
    };
  }
}
