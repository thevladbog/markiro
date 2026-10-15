import type { schema } from "@markiro/db";
import type { UsCatalogStore } from "../catalog/us-catalog-store.js";
import type { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import type { UsLotStore } from "../lots/us-lot-store.js";
import type { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import type { authorizeUsMasterData } from "../master-data/us-master-data-support.js";
import type { UsProductProfileStore } from "../products/us-product-profile-store.js";
import type { UsReceivingStore } from "../receiving/us-receiving-store.js";
import type { UsShippingStore } from "../shipping/us-shipping-draft.js";
import type { readShippingRevisions } from "../shipping/us-shipping-history.js";
import type { UsTransformationStore } from "../transformation/us-transformation-store.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract";
import type { UsDatasetJournalStore } from "./us-dataset-journal.js";
import type { lockUsDatasetShipping } from "./us-dataset-shipping-locks.js";
import type { lockUsDatasetCorrectedShipping } from "./us-dataset-corrected-shipping-locks.js";
import type {
  lockUsDatasetCorrectedReferences,
  lockUsDatasetCorrectedDocuments,
} from "./us-dataset-corrected-shipping-prepare.js";
import type { lockUsDatasetTransformation } from "./us-dataset-transformation-locks.js";
import type {
  lockUsDatasetReferenceParents,
  lockUsDatasetReceivingDocuments,
  lockUsDatasetShippingDocuments,
  lockUsDatasetShippingReferences,
  lockUsDatasetTransformationDocuments,
  readUsDatasetReceivingRootForUpdate,
  readUsDatasetReceivingRevisionForUpdate,
  readUsDatasetTransformationRevision,
} from "./us-dataset-terminal-lock-operations.js";

export type RawLot = typeof schema.traceabilityLots.$inferSelect;
export type RawEvent = typeof schema.traceabilityEvents.$inferSelect;
export type RawReceivingRoot = typeof schema.receivingEventRoots.$inferSelect;
export type RawTransformationRoot = typeof schema.transformationEventRoots.$inferSelect;
export type RawShippingRoot = typeof schema.shippingEventRoots.$inferSelect;
export type RawDocument = typeof schema.referenceDocuments.$inferSelect;

/** Fixed nonlocking point reads; absence and relation ranges are never retained. */
export type UsDatasetTerminalPointRows = Readonly<{
  lot(tx: UsDemoTransaction, tenantId: string, id: string): Promise<RawLot | undefined>;
  document(tx: UsDemoTransaction, tenantId: string, id: string): Promise<RawDocument | undefined>;
  event(tx: UsDemoTransaction, tenantId: string, id: string): Promise<RawEvent | undefined>;
  receivingRoot(
    tx: UsDemoTransaction,
    tenantId: string,
    id: string,
  ): Promise<RawReceivingRoot | undefined>;
  transformationRoot(
    tx: UsDemoTransaction,
    tenantId: string,
    id: string,
  ): Promise<RawTransformationRoot | undefined>;
  shippingRoot(
    tx: UsDemoTransaction,
    tenantId: string,
    id: string,
  ): Promise<RawShippingRoot | undefined>;
}>;

export type UsDatasetTerminalReadStores = Readonly<{
  journal: Pick<
    UsDatasetJournalStore,
    "readHeaderInTransaction" | "readStageInTransaction" | "readStagesInTransaction"
  >;
  master: Pick<
    UsMasterDataStore,
    | "getPartyInTransaction"
    | "getPartiesInTransaction"
    | "getLocationInTransaction"
    | "getLocationsInTransaction"
  >;
  catalog: Pick<UsCatalogStore, "getProductsInTransaction">;
  profiles: Pick<UsProductProfileStore, "getProfilesInTransaction">;
  documents: Pick<UsReferenceDocumentStore, "getDocumentInTransaction">;
  lots: Pick<UsLotStore, "getLotInTransaction">;
  receiving: Pick<
    UsReceivingStore,
    "getLiveRecordInTransaction" | "getLotReceivingBasisInTransaction"
  >;
  transformation: Pick<UsTransformationStore, "getRecordInTransaction">;
  shipping: Pick<UsShippingStore, "getRecordInTransaction">;
  shippingRevisions: typeof readShippingRevisions;
  authorize: typeof authorizeUsMasterData;
}>;

export type UsDatasetTerminalLockOperations = Readonly<{
  receivingRoot: typeof readUsDatasetReceivingRootForUpdate;
  receivingRevision: typeof readUsDatasetReceivingRevisionForUpdate;
  transformationRevision: typeof readUsDatasetTransformationRevision;
  referenceParents: typeof lockUsDatasetReferenceParents;
  receivingDocuments: typeof lockUsDatasetReceivingDocuments;
  transformationDocuments: typeof lockUsDatasetTransformationDocuments;
  shippingReferences: typeof lockUsDatasetShippingReferences;
  shippingDocuments: typeof lockUsDatasetShippingDocuments;
  transformation: typeof lockUsDatasetTransformation;
  shipping: typeof lockUsDatasetShipping;
}>;

export type UsDatasetTerminalDependencies = UsDatasetTerminalReadStores &
  Readonly<{
    points: UsDatasetTerminalPointRows;
    locks: UsDatasetTerminalLockOperations;
  }>;

export type UsDatasetReferenceDependencies = Pick<
  UsDatasetTerminalDependencies,
  "master" | "catalog" | "profiles"
> &
  Readonly<{ locks: Pick<UsDatasetTerminalLockOperations, "referenceParents"> }>;

export type UsDatasetReceivingDependencies = UsDatasetReferenceDependencies &
  Pick<UsDatasetTerminalDependencies, "journal" | "documents" | "receiving" | "lots"> &
  Readonly<{
    locks: Pick<
      UsDatasetTerminalLockOperations,
      "referenceParents" | "receivingDocuments" | "receivingRoot" | "receivingRevision"
    >;
  }>;

export type UsDatasetTransformationDependencies = UsDatasetReceivingDependencies &
  Pick<UsDatasetTerminalDependencies, "transformation" | "points" | "authorize"> &
  Readonly<{
    locks: Pick<
      UsDatasetTerminalLockOperations,
      | "referenceParents"
      | "receivingDocuments"
      | "receivingRoot"
      | "receivingRevision"
      | "transformationRevision"
      | "transformationDocuments"
      | "transformation"
    >;
  }>;

export type UsDatasetShippingDependencies = UsDatasetTransformationDependencies &
  Pick<UsDatasetTerminalDependencies, "shipping" | "shippingRevisions" | "authorize"> &
  Readonly<{ locks: UsDatasetTerminalLockOperations }>;

/** One fixed corrected chain; ordinary wrappers supply stateless implementations. */
export type UsDatasetCorrectedTerminalDependencies = UsDatasetTerminalReadStores &
  Readonly<{
    points: UsDatasetTerminalPointRows;
    locks: UsDatasetTerminalLockOperations &
      Readonly<{
        correctedShipping: typeof lockUsDatasetCorrectedShipping;
        correctedReferences: typeof lockUsDatasetCorrectedReferences;
        correctedDocuments: typeof lockUsDatasetCorrectedDocuments;
      }>;
  }>;
