import {
  readUsReceivingLiveRecordCore,
  readUsReceivingBasisCore,
  type UsReceivingNativeReaders,
} from "../receiving/us-receiving-store.js";
import {
  readUsTransformationRecordCore,
  type UsTransformationNativeReaders,
} from "../transformation/us-transformation-store.js";
import { readUsShippingRecordCore } from "../shipping/us-shipping-draft.js";
import {
  freshShippingHistoryReaders,
  readShippingRevisionsCore,
  type ShippingHistoryReaders,
} from "../shipping/us-shipping-history.js";
import { freshReceivingHistoryReaders } from "../receiving/us-receiving-history.js";
import { freshReceivingBasisReaders } from "../receiving/us-receiving-basis.js";
import { freshTransformationRecordReaders } from "../transformation/us-transformation-persistence.js";
import {
  freshUsMasterDataReaders,
  readUsPartyCore,
  readUsPartiesCore,
  readUsLocationCore,
  readUsLocationsCore,
  type UsMasterDataReaders,
} from "../master-data/us-master-data-read.js";
import {
  authorizeUsMasterDataCore,
  readUsMasterDataMembership,
  readUsMasterDataProfile,
  validateUsMasterDataProfile,
  type UsMasterDataRawProfile,
  type UsMasterDataTransaction,
  type PartyRow,
} from "../master-data/us-master-data-support.js";
import { freshUsLotReaders, readUsLotCore, type UsLotReaders } from "../lots/us-lot-read.js";
import {
  freshUsReferenceDocumentReaders,
  readUsReferenceDocumentCore,
  type UsReferenceDocumentReaders,
} from "../documents/us-reference-document-read.js";
import {
  freshUsCatalogReaders,
  readUsProductsCore,
  type UsCatalogReaders,
} from "../catalog/us-catalog-read.js";
import {
  freshUsProductProfileReaders,
  readUsProductProfilesCore,
  type UsProductProfileReaders,
} from "../products/us-product-profile-read.js";
import type { UsDatasetContext, UsDatasetIntent, UsDatasetReceipt } from "./us-dataset-contract.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type {
  RawLot,
  RawDocument,
  RawEvent,
  RawReceivingRoot,
  RawTransformationRoot,
  RawShippingRoot,
  UsDatasetTerminalDependencies,
  UsDatasetTerminalPointRows,
  UsDatasetTerminalLockOperations,
} from "./us-dataset-terminal-read-contract.js";
import { freshUsDatasetTerminalDependencies } from "./us-dataset-terminal-read-fresh.js";

import { verifyUsDatasetShippingProjectionCore } from "./us-dataset-shipping-verify.js";
import {
  verifyUsDatasetReceivingResultCore,
  type UsDatasetReceivingStores,
} from "./us-dataset-receiving-verify.js";
import {
  verifyUsDatasetTransformationOriginCore,
  type UsDatasetTransformationStores,
} from "./us-dataset-transformation-verify.js";
import { verifyUsDatasetCasesOriginCore } from "./us-dataset-cases-verify.js";
import { verifyUsDatasetCorrectedTransformationCore } from "./us-dataset-corrected-transformation-verify.js";
import { verifyUsDatasetCorrectedCasesCore } from "./us-dataset-corrected-cases-verify.js";
import type { UsDatasetShippingStores } from "./us-dataset-shipping-prepare.js";

type FinalCore<T> = (
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  dependencies: UsDatasetTerminalDependencies,
  mode: "fresh" | "replay",
) => Promise<T>;

/** Module-private owner. Only the named final callbacks below can allocate it. */
class NativeFinalVerifier<T> {
  constructor(
    private readonly stores: UsDatasetReceivingStores,
    private readonly verifyCore: FinalCore<T>,
    private readonly retainNativeRows = true,
  ) {}
  async #verifyTerminalProjection(
    tx: UsDemoTransaction,
    checked: UsDatasetContext,
    intent: UsDatasetIntent,
    receipt: UsDatasetReceipt,
    mode: "fresh" | "replay",
  ): Promise<T> {
    // This lexical owner exists only after apply and its immediate triggers finish.
    // No native facade or application dependency receives these implementations.
    let active = true;
    let profile: UsMasterDataRawProfile | undefined;
    const parties = new Map<string, PartyRow>();
    const lots = new Map<string, RawLot>();
    const documents = new Map<string, RawDocument>();
    const events = new Map<string, RawEvent>();
    const receivingRoots = new Map<string, RawReceivingRoot>();
    const transformationRoots = new Map<string, RawTransformationRoot>();
    const shippingRoots = new Map<string, RawShippingRoot>();
    const protectedParties = new Set<string>();
    const protectedLots = new Set<string>();
    const protectedDocuments = new Set<string>();
    const protectedEvents = new Set<string>();
    const protectedReceivingRoots = new Set<string>();
    const protectedTransformationRoots = new Set<string>();
    const protectedShippingRoots = new Set<string>();
    const fresh = freshUsDatasetTerminalDependencies(this.stores);
    const assertBound = (
      candidate: UsMasterDataTransaction,
      tenantId: string,
      actorUserId = checked.actorUserId,
    ) => {
      if (
        !active ||
        candidate !== tx ||
        tenantId !== checked.tenantId ||
        actorUserId !== checked.actorUserId
      )
        throw new Error("us_dataset_terminal_reader_binding_invalid");
    };
    const assertContext = (candidate: UsDemoTransaction, context: UsDatasetContext) => {
      assertBound(candidate, context.tenantId, context.actorUserId);
      if (
        context.expectedDatabaseName !== checked.expectedDatabaseName ||
        context.expectedDatabaseUser !== checked.expectedDatabaseUser
      )
        throw new Error("us_dataset_terminal_reader_binding_invalid");
    };
    const authorize: UsDatasetTerminalDependencies["authorize"] = (
      candidate,
      tenantId,
      actorUserId,
      required,
    ) => {
      assertBound(candidate, tenantId, actorUserId);
      return authorizeUsMasterDataCore(candidate, tenantId, actorUserId, required, {
        membership: (boundTx, boundTenant, boundActor) => {
          assertBound(boundTx, boundTenant, boundActor);
          return readUsMasterDataMembership(boundTx, boundTenant, boundActor);
        },
        profile: async (boundTx, boundTenant) => {
          assertBound(boundTx, boundTenant);
          if (profile) return { ...profile };
          const row = await readUsMasterDataProfile(boundTx, boundTenant);
          validateUsMasterDataProfile(row);
          if (row) profile = { ...row };
          return row;
        },
      });
    };
    const masterReaders: UsMasterDataReaders = {
      authorize,
      async party(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = parties.get(id);
        if (protectedParties.has(id) && saved) return structuredClone(saved);
        const row = await freshUsMasterDataReaders.party(candidate, tenantId, id);
        if (row && protectedParties.has(id)) parties.set(id, structuredClone(row));
        return row;
      },
      async parties(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        const keys = [...new Set(ids)];
        if (keys.length > 0 && keys.every((id) => protectedParties.has(id) && parties.has(id))) {
          const rows: PartyRow[] = [];
          for (const id of keys) {
            const row = parties.get(id);
            if (!row) throw new Error("us_dataset_terminal_reader_binding_invalid");
            rows.push(structuredClone(row));
          }
          return rows;
        }
        const rows = await freshUsMasterDataReaders.parties(candidate, tenantId, ids);
        // A partial finite result never installs a batch observation.
        if (rows.length === keys.length && keys.every((id) => rows.some((row) => row.id === id)))
          for (const row of rows)
            if (protectedParties.has(row.id)) parties.set(row.id, structuredClone(row));
        return rows;
      },
      location(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        return freshUsMasterDataReaders.location(candidate, tenantId, id);
      },
      locations(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        return freshUsMasterDataReaders.locations(candidate, tenantId, ids);
      },
    };
    const lotReaders: UsLotReaders = {
      authorize,
      async lot(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = lots.get(id);
        if (protectedLots.has(id) && saved) return structuredClone(saved);
        const row = await freshUsLotReaders.lot(candidate, tenantId, id);
        if (row && protectedLots.has(id)) lots.set(id, structuredClone(row));
        return row;
      },
    };
    const documentReaders: UsReferenceDocumentReaders = {
      authorize,
      async document(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = documents.get(id);
        if (protectedDocuments.has(id) && saved) return structuredClone(saved);
        const row = await freshUsReferenceDocumentReaders.document(candidate, tenantId, id);
        if (row && protectedDocuments.has(id)) documents.set(id, structuredClone(row));
        return row;
      },
    };
    const points: UsDatasetTerminalPointRows = {
      async lot(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = lots.get(id);
        if (protectedLots.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.lot(candidate, tenantId, id);
        if (row && protectedLots.has(id)) lots.set(id, structuredClone(row));
        return row;
      },
      async document(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = documents.get(id);
        if (protectedDocuments.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.document(candidate, tenantId, id);
        if (row && protectedDocuments.has(id)) documents.set(id, structuredClone(row));
        return row;
      },
      async event(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = events.get(id);
        if (protectedEvents.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.event(candidate, tenantId, id);
        if (row && protectedEvents.has(id)) events.set(id, structuredClone(row));
        return row;
      },
      async receivingRoot(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = receivingRoots.get(id);
        if (protectedReceivingRoots.has(id) && saved) return structuredClone(saved);
        return fresh.points.receivingRoot(candidate, tenantId, id);
      },
      async transformationRoot(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = transformationRoots.get(id);
        if (protectedTransformationRoots.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.transformationRoot(candidate, tenantId, id);
        if (row && protectedTransformationRoots.has(id))
          transformationRoots.set(id, structuredClone(row));
        return row;
      },
      async shippingRoot(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = shippingRoots.get(id);
        if (protectedShippingRoots.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.shippingRoot(candidate, tenantId, id);
        if (row && protectedShippingRoots.has(id)) shippingRoots.set(id, structuredClone(row));
        return row;
      },
    };
    const receivingReaders: UsReceivingNativeReaders = {
      authorize,
      history: {
        async anchor(candidate, tenantId, id) {
          assertBound(candidate, tenantId);
          const row = events.get(id);
          if (protectedEvents.has(id) && row)
            return { rootId: row.rootEventId, number: row.eventNumber, type: row.type };
          return freshReceivingHistoryReaders.anchor(candidate, tenantId, id);
        },
        root: points.receivingRoot,
        async header(candidate, tenantId, id) {
          assertBound(candidate, tenantId);
          const row = events.get(id);
          if (protectedEvents.has(id) && row) return structuredClone(row);
          return freshReceivingHistoryReaders.header(candidate, tenantId, id);
        },
      },
      basis: {
        async lot(candidate, tenantId, id) {
          assertBound(candidate, tenantId);
          const row = lots.get(id);
          if (protectedLots.has(id) && row) return structuredClone(row);
          return freshReceivingBasisReaders.lot(candidate, tenantId, id);
        },
      },
    };
    const transformationReaders: UsTransformationNativeReaders = {
      authorize,
      record: {
        async identity(candidate, tenantId, id) {
          assertBound(candidate, tenantId);
          const row = events.get(id);
          if (protectedEvents.has(id) && row?.type === "transformation")
            return { id: row.id, rootEventId: row.rootEventId };
          return freshTransformationRecordReaders.identity(candidate, tenantId, id);
        },
      },
    };
    const freshShipping = freshShippingHistoryReaders();
    const shippingHistory: ShippingHistoryReaders = {
      async event(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const saved = events.get(id);
        if (protectedEvents.has(id) && saved?.type === "shipping") return structuredClone(saved);
        const row = await freshShipping.event(candidate, tenantId, id);
        if (row && protectedEvents.has(id)) events.set(id, structuredClone(row));
        return row;
      },
      async anchor(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const row = events.get(id);
        if (protectedEvents.has(id) && row?.type === "shipping") return { rootId: row.rootEventId };
        return freshShipping.anchor(candidate, tenantId, id);
      },
      draft: {
        identity(candidate, tenantId, id) {
          assertBound(candidate, tenantId);
          return freshShipping.draft.identity(candidate, tenantId, id);
        },
      },
      snapshot: {
        async event(candidate, tenantId, id) {
          assertBound(candidate, tenantId);
          const saved = events.get(id);
          if (protectedEvents.has(id) && saved?.type === "shipping") return structuredClone(saved);
          const row = await freshShipping.snapshot.event(candidate, tenantId, id);
          if (row && protectedEvents.has(id)) events.set(id, structuredClone(row));
          return row;
        },
        async root(candidate, tenantId, id) {
          assertBound(candidate, tenantId);
          const saved = shippingRoots.get(id);
          if (protectedShippingRoots.has(id) && saved) return structuredClone(saved);
          const row = await freshShipping.snapshot.root(candidate, tenantId, id);
          if (row && protectedShippingRoots.has(id)) shippingRoots.set(id, structuredClone(row));
          return row;
        },
      },
    };
    const catalogReaders: UsCatalogReaders = {
      authorize,
      product(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        return freshUsCatalogReaders.product(candidate, tenantId, id);
      },
      products(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        return freshUsCatalogReaders.products(candidate, tenantId, ids);
      },
    };
    const profileReaders: UsProductProfileReaders = {
      authorize,
      product(candidate, tenantId, id, lock) {
        assertBound(candidate, tenantId);
        return freshUsProductProfileReaders.product(candidate, tenantId, id, lock);
      },
      products(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        return freshUsProductProfileReaders.products(candidate, tenantId, ids);
      },
      profile(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        return freshUsProductProfileReaders.profile(candidate, tenantId, id);
      },
      profiles(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        return freshUsProductProfileReaders.profiles(candidate, tenantId, ids);
      },
    };
    const retainNativeRows = this.retainNativeRows;
    const locks: UsDatasetTerminalLockOperations = {
      async shipping(candidate, context, receiving, transformation, shipping) {
        assertContext(candidate, context);
        await fresh.locks.shipping(candidate, context, receiving, transformation, shipping);
        protectedReceivingRoots.add(receiving.created.eventId);
        protectedTransformationRoots.add(transformation.created.id);
        protectedEvents.add(receiving.created.eventId);
        protectedEvents.add(transformation.created.id);
        for (const row of receiving.lots) protectedLots.add(row.id);
        protectedLots.add(transformation.outputLot.id);
        // The actual native lock plan includes Shipping rows only on replay.
        for (const row of shipping?.shipments ?? []) {
          protectedShippingRoots.add(row.created.id);
          protectedEvents.add(row.created.id);
        }
      },
      async transformation(candidate, context, target) {
        assertContext(candidate, context);
        await fresh.locks.transformation(candidate, context, target);
        if (retainNativeRows) {
          // The original successful lock protects keys, not full values. Actual
          // native point reads below populate detached rows on first use only.
          protectedReceivingRoots.add(target.receiving.created.eventId);
          protectedEvents.add(target.receiving.created.eventId);
          for (const lot of target.receiving.lots) protectedLots.add(lot.id);
          if (target.transformation) {
            protectedTransformationRoots.add(target.transformation.created.id);
            protectedEvents.add(target.transformation.created.id);
            protectedLots.add(target.transformation.outputLot.id);
          }
        }
      },
      async referenceParents(candidate, tenantId, bindings) {
        assertBound(candidate, tenantId);
        const rows = await fresh.locks.referenceParents(candidate, tenantId, bindings);
        for (const row of rows.parties) protectedParties.add(row.id);
        return rows;
      },
      async shippingReferences(candidate, tenantId, unitKey, bindings) {
        assertBound(candidate, tenantId);
        const rows = await fresh.locks.shippingReferences(candidate, tenantId, unitKey, bindings);
        for (const row of rows.parties) protectedParties.add(row.id);
        return rows;
      },
      async receivingDocuments(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        const rows = await fresh.locks.receivingDocuments(candidate, tenantId, ids);
        if (
          rows.length === new Set(ids).size &&
          ids.every((id) => rows.some((row) => row.id === id))
        )
          for (const row of rows) {
            protectedDocuments.add(row.id);
          }
        return rows;
      },
      async transformationDocuments(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        const rows = await fresh.locks.transformationDocuments(candidate, tenantId, ids);
        if (
          rows.length === new Set(ids).size &&
          ids.every((id) => rows.some((row) => row.id === id))
        )
          for (const row of rows) {
            protectedDocuments.add(row.id);
          }
        return rows;
      },
      async shippingDocuments(candidate, tenantId, ids, definitions) {
        assertBound(candidate, tenantId);
        const rows = await fresh.locks.shippingDocuments(candidate, tenantId, ids, definitions);
        // Actual selected shares protect these keys, but these partial rows are
        // never full-document values. Caller-side absence checks remain later.
        for (const row of rows) protectedDocuments.add(row.id);
        return rows;
      },
      async receivingRoot(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const row = await fresh.locks.receivingRoot(candidate, tenantId, id);
        if (row) {
          protectedReceivingRoots.add(id);
          receivingRoots.set(id, structuredClone(row));
        }
        return row;
      },
      async receivingRevision(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const row = await fresh.locks.receivingRevision(candidate, tenantId, id);
        if (row) {
          protectedEvents.add(row.id);
          events.set(row.id, structuredClone(row));
        }
        return row;
      },
      async transformationRevision(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const row = await fresh.locks.transformationRevision(candidate, tenantId, id);
        if (row && protectedEvents.has(row.id)) events.set(row.id, structuredClone(row));
        return row;
      },
    };
    const dependencies: UsDatasetTerminalDependencies = {
      authorize,
      points,
      locks,
      journal: {
        readHeaderInTransaction: (candidate, context) => {
          assertContext(candidate, context);
          return this.stores.journal.readHeaderInTransaction(candidate, context);
        },
        readStageInTransaction: (candidate, context, ...args) => {
          assertContext(candidate, context);
          return this.stores.journal.readStageInTransaction(candidate, context, ...args);
        },
        readStagesInTransaction: (candidate, context, ...args) => {
          assertContext(candidate, context);
          return this.stores.journal.readStagesInTransaction(candidate, context, ...args);
        },
      },
      master: {
        getPartyInTransaction: (candidate, tenantId, actorUserId, id) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsPartyCore(candidate, tenantId, actorUserId, id, masterReaders);
        },
        getPartiesInTransaction: (candidate, tenantId, actorUserId, ids) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsPartiesCore(candidate, tenantId, actorUserId, ids, masterReaders);
        },
        getLocationInTransaction: (candidate, tenantId, actorUserId, id) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsLocationCore(candidate, tenantId, actorUserId, id, masterReaders);
        },
        getLocationsInTransaction: (candidate, tenantId, actorUserId, ids) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsLocationsCore(candidate, tenantId, actorUserId, ids, masterReaders);
        },
      },
      catalog: {
        getProductsInTransaction: (candidate, tenantId, actorUserId, ids) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsProductsCore(candidate, tenantId, actorUserId, ids, catalogReaders);
        },
      },
      profiles: {
        getProfilesInTransaction: (candidate, tenantId, actorUserId, ids) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsProductProfilesCore(candidate, tenantId, actorUserId, ids, profileReaders);
        },
      },
      documents: {
        getDocumentInTransaction: (candidate, tenantId, actorUserId, id) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsReferenceDocumentCore(candidate, tenantId, actorUserId, id, documentReaders);
        },
      },
      lots: {
        getLotInTransaction: (candidate, tenantId, actorUserId, id) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsLotCore(candidate, tenantId, actorUserId, id, lotReaders);
        },
      },
      receiving: {
        getLiveRecordInTransaction: (candidate, tenantId, actorUserId, id) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsReceivingLiveRecordCore(
            candidate,
            tenantId,
            actorUserId,
            id,
            receivingReaders,
          );
        },
        getLotReceivingBasisInTransaction: (candidate, tenantId, actorUserId, id, query) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsReceivingBasisCore(
            candidate,
            tenantId,
            actorUserId,
            id,
            query,
            receivingReaders,
          );
        },
      },
      transformation: {
        getRecordInTransaction: (candidate, tenantId, actorUserId, id) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsTransformationRecordCore(
            candidate,
            tenantId,
            actorUserId,
            id,
            transformationReaders,
          );
        },
      },
      shipping: {
        getRecordInTransaction: (candidate, tenantId, actorUserId, id) => {
          assertBound(candidate, tenantId, actorUserId);
          return readUsShippingRecordCore(candidate, tenantId, actorUserId, id, {
            authorize,
            history: shippingHistory,
          });
        },
      },
      shippingRevisions: (candidate, tenantId, id, query) => {
        assertBound(candidate, tenantId);
        return readShippingRevisionsCore(candidate, tenantId, id, query, shippingHistory);
      },
    };
    try {
      return await this.verifyCore(tx, checked, intent, receipt, dependencies, mode);
    } finally {
      active = false;
      profile = undefined;
      parties.clear();
      lots.clear();
      documents.clear();
      events.clear();
      receivingRoots.clear();
      transformationRoots.clear();
      shippingRoots.clear();
      protectedParties.clear();
      protectedLots.clear();
      protectedDocuments.clear();
      protectedEvents.clear();
      protectedReceivingRoots.clear();
      protectedTransformationRoots.clear();
      protectedShippingRoots.clear();
    }
  }
  verify(
    tx: UsDemoTransaction,
    checked: UsDatasetContext,
    intent: UsDatasetIntent,
    receipt: UsDatasetReceipt,
    mode: "fresh" | "replay",
  ): Promise<T> {
    return this.#verifyTerminalProjection(tx, checked, intent, receipt, mode);
  }
}

export async function verifyUsDatasetReceivingFinal(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetReceivingStores,
): Promise<void> {
  await new NativeFinalVerifier(stores, (tx, context, intent, receipt, d) =>
    verifyUsDatasetReceivingResultCore(tx, context, intent, receipt, d),
  ).verify(tx, context, intent, receipt, "replay");
}
export async function verifyUsDatasetTransformationFinal(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetTransformationStores,
  mode: "fresh" | "replay",
): Promise<void> {
  await new NativeFinalVerifier(stores, verifyUsDatasetTransformationOriginCore).verify(
    tx,
    context,
    intent,
    receipt,
    mode,
  );
}
export async function verifyUsDatasetCasesFinal(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  mode: "fresh" | "replay",
  stores: UsDatasetTransformationStores,
): Promise<void> {
  await new NativeFinalVerifier(stores, (tx, context, intent, receipt, d, mode) =>
    verifyUsDatasetCasesOriginCore(tx, context, intent, receipt, mode, d),
  ).verify(tx, context, intent, receipt, mode);
}
export async function verifyUsDatasetCorrectedTransformationFinal(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetTransformationStores,
  mode: "fresh" | "replay",
): Promise<void> {
  await new NativeFinalVerifier(stores, verifyUsDatasetCorrectedTransformationCore).verify(
    tx,
    context,
    intent,
    receipt,
    mode,
  );
}
export async function verifyUsDatasetCorrectedCasesFinal(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  mode: "fresh" | "replay",
  stores: UsDatasetTransformationStores,
): Promise<void> {
  await new NativeFinalVerifier(stores, (tx, context, intent, receipt, d, mode) =>
    verifyUsDatasetCorrectedCasesCore(tx, context, intent, receipt, mode, d),
  ).verify(tx, context, intent, receipt, mode);
}
export function verifyUsDatasetShippingFinal(
  tx: UsDemoTransaction,
  context: UsDatasetContext,
  intent: UsDatasetIntent,
  receipt: UsDatasetReceipt,
  stores: UsDatasetShippingStores,
  mode: "fresh" | "replay",
) {
  return new NativeFinalVerifier(stores, verifyUsDatasetShippingProjectionCore, false).verify(
    tx,
    context,
    intent,
    receipt,
    mode,
  );
}
