import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type { CreateShippingDraftInput } from "@markiro/platform-contracts";
import { UsCatalogStore } from "../catalog/us-catalog-store.js";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store.js";
import { UsLotStore } from "../lots/us-lot-store.js";
import { UsMasterDataStore } from "../master-data/us-master-data-store.js";
import { UsProductProfileStore } from "../products/us-product-profile-store.js";
import {
  UsReceivingStore,
  readUsReceivingLiveRecordCore,
  readUsReceivingBasisCore,
  type UsReceivingNativeReaders,
} from "../receiving/us-receiving-store.js";
import {
  UsTransformationStore,
  readUsTransformationRecordCore,
  type UsTransformationNativeReaders,
} from "../transformation/us-transformation-store.js";
import { UsShippingStore, readUsShippingRecordCore } from "../shipping/us-shipping-draft.js";
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
import type {
  UsDatasetContext,
  UsDatasetStageRow,
  UsDatasetIntent,
  UsDatasetReceipt,
} from "./us-dataset-contract.js";
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
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import { makeUsDatasetTransformationIdentity } from "./us-dataset-cases-contract.js";
import { makeUsDatasetReferenceIdentity } from "./us-dataset-receiving-contract.js";
import { parseUsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import {
  makeUsDatasetReceivingIdentity,
  parseUsDatasetTransformationResult,
} from "./us-dataset-transformation-contract.js";
import {
  datasetShippingError,
  makeUsDatasetShippingInput,
  makeUsDatasetShippingPlan,
  parseUsDatasetShippingInput,
  parseUsDatasetShippingResult,
  usDatasetShippingOperationKey,
  usDatasetShippingRecordIds,
  type UsDatasetShippingResult,
  type UsDatasetShippingShipmentResult,
} from "./us-dataset-shipping-contract.js";
import {
  prepareUsDatasetShipping,
  type UsDatasetShippingStores,
} from "./us-dataset-shipping-prepare.js";
import { verifyUsDatasetShippingProjectionCore } from "./us-dataset-shipping-verify.js";
import { makeUsSixMonthRegularChain } from "./us-six-month-chains.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";
import type { UsDatasetShippingProjection } from "./us-dataset-shipping-projection.js";

export class UsDatasetShippingSeedStore {
  private readonly stores: UsDatasetShippingStores;
  constructor(db: Db) {
    this.stores = {
      journal: new UsDatasetJournalStore(db, usSixMonthDefinition),
      master: new UsMasterDataStore(db),
      catalog: new UsCatalogStore(db),
      profiles: new UsProductProfileStore(db),
      documents: new UsReferenceDocumentStore(db),
      lots: new UsLotStore(db),
      receiving: new UsReceivingStore(db),
      transformation: new UsTransformationStore(db),
      shipping: new UsShippingStore(db),
    };
  }
  async initialize(context: UsDatasetContext, index: number): Promise<UsDatasetShippingResult> {
    return (await this.execute(context, index, true)).shipping;
  }
  initializeTerminalProjection(
    context: UsDatasetContext,
    index: number,
  ): Promise<UsDatasetShippingProjection> {
    return this.execute(context, index, true);
  }
  async verify(context: UsDatasetContext, index: number): Promise<UsDatasetShippingResult> {
    return (await this.execute(context, index, false)).shipping;
  }
  verifyTerminalProjection(
    context: UsDatasetContext,
    index: number,
  ): Promise<UsDatasetShippingProjection> {
    return this.execute(context, index, false);
  }
  async #verifyTerminalProjection(
    tx: UsDemoTransaction,
    checked: UsDatasetContext,
    intent: UsDatasetIntent,
    receipt: UsDatasetReceipt,
    mode: "fresh" | "replay",
  ): Promise<UsDatasetShippingProjection> {
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
        // Shipping's stricter successful lock operation already established the
        // exact root/event/lot keys for this closed dependency chain.
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
          for (const row of rows) protectedDocuments.add(row.id);
        return rows;
      },
      async transformationDocuments(candidate, tenantId, ids) {
        assertBound(candidate, tenantId);
        const rows = await fresh.locks.transformationDocuments(candidate, tenantId, ids);
        if (
          rows.length === new Set(ids).size &&
          ids.every((id) => rows.some((row) => row.id === id))
        )
          for (const row of rows) protectedDocuments.add(row.id);
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
        if (row && protectedReceivingRoots.has(id)) receivingRoots.set(id, structuredClone(row));
        return row;
      },
      async receivingRevision(candidate, tenantId, id) {
        assertBound(candidate, tenantId);
        const row = await fresh.locks.receivingRevision(candidate, tenantId, id);
        if (row && protectedEvents.has(row.id)) events.set(row.id, structuredClone(row));
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
      return await verifyUsDatasetShippingProjectionCore(
        tx,
        checked,
        intent,
        receipt,
        dependencies,
        mode,
      );
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
  private async execute(
    context: UsDatasetContext,
    index: number,
    capture: boolean,
  ): Promise<UsDatasetShippingProjection> {
    let unitKey = "unknown";
    try {
      const { journal } = this.stores;
      const header = await journal.read(context);
      if (!header)
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      let chain;
      try {
        chain = makeUsSixMonthRegularChain(index);
        unitKey = chain.unitKey;
      } catch (cause) {
        throw datasetShippingError("us_dataset_shipping_input_invalid", unitKey, cause);
      }
      const [references, receiving, transformation, cases] = await journal.readStages(
        context,
        header.id,
        [
          { unitKey: "references", stage: "references" },
          { unitKey, stage: "receiving" },
          { unitKey, stage: "transformation" },
          { unitKey, stage: "cases" },
        ],
      );
      if (
        !references?.receipt ||
        !receiving?.receipt ||
        !transformation?.receipt ||
        !cases?.receipt
      )
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      const origin = parseUsDatasetTransformationResult(transformation.receipt.result);
      const input = makeUsDatasetShippingInput(
        index,
        makeUsDatasetReferenceIdentity(header.id, references),
        makeUsDatasetReceivingIdentity(header.id, receiving),
        makeUsDatasetTransformationIdentity(header.id, transformation),
        origin.outputLot.id,
        origin.outputLot.productId,
      );
      const checkedStage = (stage: UsDatasetStageRow | null) => {
        if (
          stage &&
          (stage.unitKey !== unitKey ||
            stage.stage !== "shipping" ||
            canonicalExportDigest(parseUsDatasetShippingInput(stage.intent.input)) !==
              canonicalExportDigest(input))
        )
          throw datasetShippingError("us_dataset_shipping_dependency_conflict", unitKey);
        return stage;
      };
      let stage = checkedStage(await journal.readStage(context, header.id, unitKey, "shipping"));
      if (!stage && capture) {
        try {
          stage = checkedStage(
            await journal.captureIntent(context, header.id, {
              unitKey,
              stage: "shipping",
              operationKey: randomUUID(),
              input,
              inputDigest: canonicalExportDigest(input),
            }),
          );
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "us_dataset_intent_conflict")
            throw error;
          stage = checkedStage(await journal.readStage(context, header.id, unitKey, "shipping"));
          if (!stage) throw error;
        }
      }
      if (!stage || (!capture && !stage.receipt))
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      let applied = false;
      // Invocation-local only: a callback result cannot escape before COMMIT.
      let projection: UsDatasetShippingProjection | undefined;
      const completed = await journal.runAtomicStage(
        context,
        header.id,
        stage.revision,
        stage.intent,
        {
          apply: async (tx, checked, intent) => {
            if (!capture)
              throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
            const prepared = await prepareUsDatasetShipping(
              tx,
              checked,
              header.id,
              unitKey,
              "application",
              this.stores,
            );
            const bindings = parseUsDatasetReferenceResult(
              prepared.references.receipt?.result,
            ).bindings;
            const bound = (rows: readonly { key: string; id: string }[], key: string) => {
              const row = rows.find((entry) => entry.key === key);
              if (!row) throw datasetShippingError("us_dataset_shipping_conflict", unitKey);
              return row.id;
            };
            const shipments: UsDatasetShippingShipmentResult[] = [];
            // Fresh document/root rows are private inserts. All public receipt-owned
            // references and documents were retained before Cases support locks.
            for (const row of makeUsDatasetShippingPlan(prepared.input)) {
              const operationKey = usDatasetShippingOperationKey(
                intent.operationKey,
                row.shipmentNo,
              );
              const requestId = `dataset-shipping:${intent.operationKey}:${row.shipmentNo}`;
              const documents = [];
              for (const number of row.references) {
                const definition = prepared.input.chain.documents.find(
                  (entry) => entry.input.number === number,
                );
                if (!definition)
                  throw datasetShippingError("us_dataset_shipping_conflict", unitKey);
                const record = await this.stores.documents.createDocumentInTransaction(
                  tx,
                  checked.tenantId,
                  checked.actorUserId,
                  { ...definition.input, partyId: bound(bindings.parties, definition.partyKey) },
                  requestId,
                );
                documents.push({ key: definition.key, record });
              }
              const createInput: CreateShippingDraftInput = {
                operationKey,
                draft: {
                  eventDate: row.eventDate,
                  shipFromLocationId: bound(bindings.locations, row.shippingLocationKey),
                  recipientLocationId: bound(bindings.locations, row.recipientLocationKey),
                  carrierReference: null,
                  notes: "Synthetic six-month demo shipment.",
                  items: [
                    {
                      lotId: prepared.input.outputLotId,
                      quantity: row.quantity,
                      unitOfMeasure: row.unitOfMeasure,
                    },
                  ],
                  documentIds: documents.map(({ record }) => record.id),
                },
              };
              const created = await this.stores.shipping.createDraftInTransaction(
                tx,
                checked.tenantId,
                checked.actorUserId,
                createInput,
                requestId,
              );
              const ready = await this.stores.shipping.checkReadinessInTransaction(
                tx,
                checked.tenantId,
                checked.actorUserId,
                created.id,
                { expectedDraftVersion: created.draftVersion },
              );
              if (ready.state !== "complete")
                throw datasetShippingError("us_dataset_shipping_conflict", unitKey);
              const finalizeInput = {
                operationKey,
                expectedDraftVersion: created.draftVersion,
                expectedInputDigest: ready.inputDigest,
              };
              const finalized = await this.stores.shipping.finalizeInTransaction(
                tx,
                checked.tenantId,
                checked.actorUserId,
                created.id,
                finalizeInput,
                requestId,
              );
              shipments.push({
                shipmentNo: row.shipmentNo,
                operationKey,
                requestId,
                documents,
                createInput,
                finalizeInput,
                created,
                finalized,
              });
            }
            const outputLotAfter = await this.stores.lots.getLotInTransaction(
              tx,
              checked.tenantId,
              checked.actorUserId,
              prepared.input.outputLotId,
            );
            const result = parseUsDatasetShippingResult({
              input: prepared.input,
              originLot: parseUsDatasetTransformationResult(prepared.transformation.receipt?.result)
                .outputLot,
              outputLotAfter,
              shipments,
            });
            applied = true;
            return {
              result,
              recordIds: usDatasetShippingRecordIds(result),
              resultDigest: canonicalExportDigest(result),
            };
          },
          verify: async (tx, checked, intent, receipt) => {
            projection = await this.#verifyTerminalProjection(
              tx,
              checked,
              intent,
              receipt,
              applied ? "fresh" : "replay",
            );
          },
        },
      );
      if (!completed.receipt)
        throw datasetShippingError("us_dataset_shipping_prerequisite_incomplete", unitKey);
      if (!projection) throw datasetShippingError("us_dataset_shipping_mismatch", unitKey);
      return projection;
    } catch (error) {
      if (error instanceof Error && Object.isExtensible(error)) {
        try {
          Object.defineProperties(error, {
            unitKey: { value: unitKey, enumerable: true, configurable: true, writable: true },
            stage: { value: "shipping", enumerable: true, configurable: true, writable: true },
          });
        } catch {
          /* Keep original driver/domain identity if annotations cannot be changed. */
        }
      }
      throw error;
    }
  }
}
