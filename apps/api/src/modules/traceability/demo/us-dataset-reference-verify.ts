import { canonicalExportDigest, canonicalExportEqual } from "./us-demo-canonical.js";

import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  usLocationSchema,
  usPartySchema,
  usProductSchema,
  productTraceabilityProfileSchema,
} from "@markiro/platform-contracts";
import type { UsCatalogStore } from "../catalog/us-catalog-store.js";
import type { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import type { UsProductProfileStore } from "../products/us-product-profile-store.js";
import { canonicalPackageSize, editableProfile } from "../products/us-product-profile-support.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";
import {
  datasetReferenceError,
  parseUsDatasetReferenceResult,
} from "./us-dataset-reference-contract.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import { makeUsSixMonthCatalogue } from "./us-six-month-references.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";
import type { UsDatasetReferenceDependencies } from "./us-dataset-terminal-read-contract.js";

const catalogue = makeUsSixMonthCatalogue();
const expectedInput = Object.freeze({
  version: usSixMonthDefinition.version,
  definitionDigest: usSixMonthDefinition.digest,
  catalogue,
});
const expectedInputDigest = canonicalExportDigest(expectedInput);

export type UsDatasetReferenceStores = Readonly<{
  master: UsMasterDataStore;
  catalog: UsCatalogStore;
  profiles: UsProductProfileStore;
}>;

function equal(left: unknown, right: unknown): void {
  if (!canonicalExportEqual(left, right))
    throw datasetReferenceError("us_dataset_reference_mismatch");
}

/** Compare only receipt-owned rows, held in fixed table/ID lock order until commit. */
export async function verifyUsDatasetReferences(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetReferenceStores,
): Promise<void> {
  return verifyUsDatasetReferencesCore(
    tx,
    context,
    intent,
    receipt,
    freshUsDatasetTerminalDependencies(stores),
  );
}

export async function verifyUsDatasetReferencesCore(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetReferenceDependencies,
): Promise<void> {
  if (intent.unitKey !== "references" || intent.stage !== "references")
    throw datasetReferenceError("us_dataset_reference_mismatch");
  if (canonicalExportDigest(intent.input) !== expectedInputDigest)
    throw datasetReferenceError("us_dataset_reference_mismatch");
  equal(intent.inputDigest, expectedInputDigest);
  const result = parseUsDatasetReferenceResult(receipt.result);
  equal(
    receipt.recordIds,
    [...result.bindings.parties, ...result.bindings.locations, ...result.bindings.products].map(
      ({ id }) => id,
    ),
  );
  equal(receipt.resultDigest, canonicalExportDigest(result));
  const { tenantId, actorUserId } = context;
  // Native ordinary getters do not lock these rows. Lock all owned parents first,
  // then locations, then products; profile writers serialize on their product.
  await stores.locks.referenceParents(tx, tenantId, result.bindings);
  try {
    const parties = await stores.master.getPartiesInTransaction(
      tx,
      tenantId,
      actorUserId,
      result.bindings.parties.map(({ id }) => id),
    );
    const locations = await stores.master.getLocationsInTransaction(
      tx,
      tenantId,
      actorUserId,
      result.bindings.locations.map(({ id }) => id),
    );
    const products = await stores.catalog.getProductsInTransaction(
      tx,
      tenantId,
      actorUserId,
      result.bindings.products.map(({ id }) => id),
    );
    const profiles = await stores.profiles.getProfilesInTransaction(
      tx,
      tenantId,
      actorUserId,
      result.bindings.products.map(({ id }) => id),
    );
    for (const [index, item] of catalogue.parties.entries()) {
      const saved = result.evidence.parties[index];
      if (!saved) throw datasetReferenceError("us_dataset_reference_mismatch");
      equal(saved, {
        ...item.input,
        id: result.bindings.parties[index]?.id,
        archived: false,
        createdAt: saved.createdAt,
        updatedAt: saved.createdAt,
      });
      const current = parties[index];
      equal(usPartySchema.parse(current), current);
      equal(current, saved);
    }
    for (const [index, item] of catalogue.locations.entries()) {
      const saved = result.evidence.locations[index];
      if (!saved) throw datasetReferenceError("us_dataset_reference_mismatch");
      equal(saved, {
        ...item.input,
        id: result.bindings.locations[index]?.id,
        partyId: result.bindings.parties.find(({ key }) => key === item.partyKey)?.id,
        archived: false,
        createdAt: saved.createdAt,
        updatedAt: saved.createdAt,
        descriptionStatus: { exportReady: true, issues: [] },
      });
      const current = locations[index];
      equal(usLocationSchema.parse(current), current);
      equal(current, saved);
    }
    for (const [index, item] of catalogue.products.entries()) {
      const product = result.evidence.products[index];
      const profile = result.evidence.profiles[index];
      if (!product || !profile || profile.createdAt === null)
        throw datasetReferenceError("us_dataset_reference_mismatch");
      equal(product, {
        id: result.bindings.products[index]?.id,
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
      const currentProduct = products[index];
      equal(usProductSchema.parse(currentProduct), currentProduct);
      equal(currentProduct, product);
      const currentProfile = profiles[index];
      equal(productTraceabilityProfileSchema.parse(currentProfile), currentProfile);
      equal(currentProfile, profile);
    }
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      error instanceof ServiceUnavailableException ||
      (error instanceof Error && error.name === "ZodError")
    )
      throw datasetReferenceError("us_dataset_reference_mismatch", error);
    throw error;
  }
}
