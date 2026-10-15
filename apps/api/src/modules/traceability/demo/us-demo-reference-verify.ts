import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { UsCatalogStore } from "../catalog/us-catalog-store.js";
import type { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import type { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import type { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { canonicalPackageSize, editableProfile } from "../products/us-product-profile-support.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  UsDemoIntent,
  UsDemoJournalContext,
  UsDemoReceipt,
} from "./us-demo-journal-contract.js";
import {
  makeUsDemoReferenceRecipe,
  parseUsDemoReferenceResult,
} from "./us-demo-reference-recipe.js";

/** Actual Db-owned services; every canonical getter receives the journal's guarded transaction. */
export type UsDemoReferenceStores = Readonly<{
  master: UsMasterDataStore;
  catalog: UsCatalogStore;
  profiles: UsProductProfileStore;
  documents: UsReferenceDocumentStore;
}>;

function equal(left: unknown, right: unknown): void {
  if (!canonicalExportEqual(left, right)) throw new Error("us_demo_reference_mismatch");
}

export async function verifyUsDemoReferences(
  tx: UsDemoTransaction,
  context: UsDemoJournalContext,
  intent: UsDemoIntent,
  receipt: UsDemoReceipt,
  stores: UsDemoReferenceStores,
): Promise<void> {
  const recipe = makeUsDemoReferenceRecipe();
  if (intent.stage !== "references" || intent.inputDigest !== canonicalExportDigest(recipe))
    throw new Error("us_demo_reference_mismatch");
  equal(intent.input, recipe);
  const result = parseUsDemoReferenceResult(receipt.result);
  equal(
    receipt.recordIds,
    [
      ...result.evidence.parties,
      ...result.evidence.locations,
      ...result.evidence.products,
      ...result.evidence.documents,
    ].map((record) => record.id),
  );
  equal(receipt.resultDigest, canonicalExportDigest(result));
  const { tenantId, actorUserId } = context;
  try {
    for (const [index, item] of recipe.parties.entries()) {
      const saved = result.evidence.parties[index];
      if (!saved) throw new Error("us_demo_reference_mismatch");
      equal(saved, {
        ...item.input,
        id: result.bindings.parties[item.key],
        archived: false,
        createdAt: saved.createdAt,
        updatedAt: saved.createdAt,
      });
      equal(await stores.master.getPartyInTransaction(tx, tenantId, actorUserId, saved.id), saved);
    }
    for (const [index, item] of recipe.locations.entries()) {
      const saved = result.evidence.locations[index];
      if (!saved) throw new Error("us_demo_reference_mismatch");
      equal(saved, {
        ...item.input,
        id: result.bindings.locations[item.key],
        partyId: result.bindings.parties[item.partyKey],
        archived: false,
        createdAt: saved.createdAt,
        updatedAt: saved.createdAt,
        descriptionStatus: { exportReady: true, issues: [] },
      });
      equal(
        await stores.master.getLocationInTransaction(tx, tenantId, actorUserId, saved.id),
        saved,
      );
    }
    for (const [index, item] of recipe.products.entries()) {
      const product = result.evidence.products[index];
      const profile = result.evidence.profiles[index];
      if (!product || !profile || profile.createdAt === null)
        throw new Error("us_demo_reference_mismatch");
      equal(product, {
        id: result.bindings.products[item.key],
        name: item.input.name,
        gtin14: null,
        archived: false,
        createdAt: product.createdAt,
        updatedAt: product.createdAt,
      });
      const editable = editableProfile(item.profile);
      equal(profile, {
        ...editable,
        productId: product.id,
        packagingSizeValue: canonicalPackageSize(editable.packagingSizeValue),
        revision: 1,
        reviewedBy: actorUserId,
        reviewedAt: profile.createdAt,
        createdAt: profile.createdAt,
        updatedAt: profile.createdAt,
      });
      equal(
        await stores.catalog.getProductInTransaction(tx, tenantId, actorUserId, product.id),
        product,
      );
      equal(
        await stores.profiles.getProfileInTransaction(tx, tenantId, actorUserId, product.id),
        profile,
      );
    }
    for (const [index, item] of recipe.documents.entries()) {
      const saved = result.evidence.documents[index];
      if (!saved) throw new Error("us_demo_reference_mismatch");
      equal(saved, {
        ...item.input,
        id: result.bindings.documents[item.key],
        partyId: result.bindings.parties[item.partyKey],
        archivedAt: null,
        createdBy: actorUserId,
        createdAt: saved.createdAt,
        updatedAt: saved.createdAt,
      });
      equal(
        await stores.documents.getDocumentInTransaction(tx, tenantId, actorUserId, saved.id),
        saved,
      );
    }
  } catch (error) {
    // Business absence/invalid persisted response is a mismatch; SQL/driver errors retain their identity.
    if (error instanceof NotFoundException || error instanceof ServiceUnavailableException)
      throw new Error("us_demo_reference_mismatch", { cause: error });
    throw error;
  }
}
