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
import { freshReceivingHistoryReaders } from "../receiving/us-receiving-history.js";
import { freshReceivingBasisReaders } from "../receiving/us-receiving-basis.js";
import { freshTransformationRecordReaders } from "../transformation/us-transformation-persistence.js";
import {
  freshShippingHistoryReaders,
  readShippingRevisionsCore,
  type ShippingHistoryReaders,
} from "../shipping/us-shipping-history.js";
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
  UsDatasetCorrectedTerminalDependencies,
  UsDatasetTerminalPointRows,
} from "./us-dataset-terminal-read-contract.js";
import { UsDatasetJournalStore } from "./us-dataset-journal.js";
import {
  usDatasetShippingOperationKey,
  type UsDatasetShippingShipmentResult,
} from "./us-dataset-shipping-contract.js";
import type { UsDatasetShippingStores } from "./us-dataset-shipping-prepare.js";
import {
  authorizeUsDatasetCorrectedShipping,
  prepareUsDatasetCorrectedShipping,
  readUsDatasetCorrectedShippingInput,
  freshUsDatasetCorrectedTerminalDependencies,
} from "./us-dataset-corrected-shipping-prepare.js";
import {
  makeUsDatasetCorrectedShippingPlan,
  parseUsDatasetCorrectedShippingInput,
} from "./us-dataset-corrected-shipping-contract.js";
import {
  datasetCorrectedShippingError,
  parseUsDatasetCorrectedShippingResult,
  usDatasetCorrectedShippingRecordIds,
  type UsDatasetCorrectedShippingResult,
} from "./us-dataset-corrected-shipping-result.js";
import { verifyUsDatasetCorrectedShippingCore } from "./us-dataset-corrected-shipping-verify.js";
import { usSixMonthDefinition } from "./us-six-month-definition.js";

export class UsDatasetCorrectedShippingSeedStore {
  private readonly stores: UsDatasetShippingStores;
  constructor(private readonly db: Db) {
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
  initialize(context: UsDatasetContext): Promise<UsDatasetCorrectedShippingResult> {
    return this.execute(context, true);
  }
  verify(context: UsDatasetContext): Promise<UsDatasetCorrectedShippingResult> {
    return this.execute(context, false);
  }
  async #verifyTerminal(
    tx: UsDemoTransaction,
    checked: UsDatasetContext,
    intent: UsDatasetIntent,
    receipt: UsDatasetReceipt,
    mode: "fresh" | "replay",
  ): Promise<void> {
    // Allocated only by final verification, after application/immediate triggers.
    // The accepted regular owner has the same binding/clone/revocation mechanics;
    // this fixed corrected chain deliberately owns separate protection evidence.
    let active = true;
    let profile: UsMasterDataRawProfile | undefined;
    const parties = new Map<string, PartyRow>(),
      lots = new Map<string, RawLot>(),
      documents = new Map<string, RawDocument>(),
      events = new Map<string, RawEvent>();
    const receivingRoots = new Map<string, RawReceivingRoot>(),
      transformationRoots = new Map<string, RawTransformationRoot>(),
      shippingRoots = new Map<string, RawShippingRoot>();
    const protectedParties = new Set<string>(),
      protectedLots = new Set<string>(),
      protectedDocuments = new Set<string>(),
      protectedEvents = new Set<string>(),
      protectedReceivingRoots = new Set<string>(),
      protectedTransformationRoots = new Set<string>(),
      protectedShippingRoots = new Set<string>();
    const fresh = freshUsDatasetCorrectedTerminalDependencies(this.stores);
    const bound = (
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
    const contextBound = (candidate: UsDemoTransaction, context: UsDatasetContext) => {
      bound(candidate, context.tenantId, context.actorUserId);
      if (
        context.expectedDatabaseName !== checked.expectedDatabaseName ||
        context.expectedDatabaseUser !== checked.expectedDatabaseUser
      )
        throw new Error("us_dataset_terminal_reader_binding_invalid");
    };
    const authorize: UsDatasetCorrectedTerminalDependencies["authorize"] = (
      candidate,
      tenantId,
      actorUserId,
      required,
    ) => {
      bound(candidate, tenantId, actorUserId);
      return authorizeUsMasterDataCore(candidate, tenantId, actorUserId, required, {
        membership: (t, tenant, actor) => {
          bound(t, tenant, actor);
          return readUsMasterDataMembership(t, tenant, actor);
        },
        profile: async (t, tenant) => {
          bound(t, tenant);
          if (profile) return structuredClone(profile);
          const row = await readUsMasterDataProfile(t, tenant);
          validateUsMasterDataProfile(row);
          if (row) profile = structuredClone(row);
          return row;
        },
      });
    };
    const masterReaders: UsMasterDataReaders = {
      authorize,
      async party(t, tenant, id) {
        bound(t, tenant);
        const saved = parties.get(id);
        if (protectedParties.has(id) && saved) return structuredClone(saved);
        const row = await freshUsMasterDataReaders.party(t, tenant, id);
        if (row && protectedParties.has(id)) parties.set(id, structuredClone(row));
        return row;
      },
      async parties(t, tenant, ids) {
        bound(t, tenant);
        const keys = [...new Set(ids)];
        if (keys.length && keys.every((id) => protectedParties.has(id) && parties.has(id))) {
          const rows: PartyRow[] = [];
          for (const id of keys) {
            const row = parties.get(id);
            if (!row) throw new Error("us_dataset_terminal_reader_binding_invalid");
            rows.push(structuredClone(row));
          }
          return rows;
        }
        const rows = await freshUsMasterDataReaders.parties(t, tenant, ids);
        if (rows.length === keys.length && keys.every((id) => rows.some((row) => row.id === id)))
          for (const row of rows)
            if (protectedParties.has(row.id)) parties.set(row.id, structuredClone(row));
        return rows;
      },
      location(t, tenant, id) {
        bound(t, tenant);
        return freshUsMasterDataReaders.location(t, tenant, id);
      },
      locations(t, tenant, ids) {
        bound(t, tenant);
        return freshUsMasterDataReaders.locations(t, tenant, ids);
      },
    };
    const lotReaders: UsLotReaders = {
      authorize,
      async lot(t, tenant, id) {
        bound(t, tenant);
        const saved = lots.get(id);
        if (protectedLots.has(id) && saved) return structuredClone(saved);
        const row = await freshUsLotReaders.lot(t, tenant, id);
        if (row && protectedLots.has(id)) lots.set(id, structuredClone(row));
        return row;
      },
    };
    const documentReaders: UsReferenceDocumentReaders = {
      authorize,
      async document(t, tenant, id) {
        bound(t, tenant);
        const saved = documents.get(id);
        if (protectedDocuments.has(id) && saved) return structuredClone(saved);
        const row = await freshUsReferenceDocumentReaders.document(t, tenant, id);
        if (row && protectedDocuments.has(id)) documents.set(id, structuredClone(row));
        return row;
      },
    };
    const points: UsDatasetTerminalPointRows = {
      lot: lotReaders.lot,
      async document(t, tenant, id) {
        bound(t, tenant);
        const saved = documents.get(id);
        if (protectedDocuments.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.document(t, tenant, id);
        if (row && protectedDocuments.has(id)) documents.set(id, structuredClone(row));
        return row;
      },
      async event(t, tenant, id) {
        bound(t, tenant);
        const saved = events.get(id);
        if (protectedEvents.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.event(t, tenant, id);
        if (row && protectedEvents.has(id)) events.set(id, structuredClone(row));
        return row;
      },
      async receivingRoot(t, tenant, id) {
        bound(t, tenant);
        const saved = receivingRoots.get(id);
        if (protectedReceivingRoots.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.receivingRoot(t, tenant, id);
        if (row && protectedReceivingRoots.has(id)) receivingRoots.set(id, structuredClone(row));
        return row;
      },
      async transformationRoot(t, tenant, id) {
        bound(t, tenant);
        const saved = transformationRoots.get(id);
        if (protectedTransformationRoots.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.transformationRoot(t, tenant, id);
        if (row && protectedTransformationRoots.has(id))
          transformationRoots.set(id, structuredClone(row));
        return row;
      },
      async shippingRoot(t, tenant, id) {
        bound(t, tenant);
        const saved = shippingRoots.get(id);
        if (protectedShippingRoots.has(id) && saved) return structuredClone(saved);
        const row = await fresh.points.shippingRoot(t, tenant, id);
        if (row && protectedShippingRoots.has(id)) shippingRoots.set(id, structuredClone(row));
        return row;
      },
    };
    const receivingReaders: UsReceivingNativeReaders = {
      authorize,
      history: {
        async anchor(t, tenant, id) {
          bound(t, tenant);
          const row = events.get(id);
          if (protectedEvents.has(id) && row)
            return { rootId: row.rootEventId, number: row.eventNumber, type: row.type };
          return freshReceivingHistoryReaders.anchor(t, tenant, id);
        },
        root: points.receivingRoot,
        async header(t, tenant, id) {
          bound(t, tenant);
          const saved = events.get(id);
          if (protectedEvents.has(id) && saved) return structuredClone(saved);
          const row = await freshReceivingHistoryReaders.header(t, tenant, id);
          if (row && protectedEvents.has(id)) events.set(id, structuredClone(row));
          return row;
        },
      },
      basis: {
        async lot(t, tenant, id) {
          bound(t, tenant);
          const row = lots.get(id);
          if (protectedLots.has(id) && row) return structuredClone(row);
          return freshReceivingBasisReaders.lot(t, tenant, id);
        },
      },
    };
    const transformationReaders: UsTransformationNativeReaders = {
      authorize,
      record: {
        async identity(t, tenant, id) {
          bound(t, tenant);
          const row = events.get(id);
          if (protectedEvents.has(id) && row?.type === "transformation")
            return { id: row.id, rootEventId: row.rootEventId };
          return freshTransformationRecordReaders.identity(t, tenant, id);
        },
      },
    };
    const freshShipping = freshShippingHistoryReaders();
    const shippingReaders: ShippingHistoryReaders = {
      async event(t, tenant, id) {
        bound(t, tenant);
        const saved = events.get(id);
        if (protectedEvents.has(id) && saved?.type === "shipping") return structuredClone(saved);
        const row = await freshShipping.event(t, tenant, id);
        if (row && protectedEvents.has(id)) events.set(id, structuredClone(row));
        return row;
      },
      async anchor(t, tenant, id) {
        bound(t, tenant);
        const row = events.get(id);
        if (protectedEvents.has(id) && row?.type === "shipping") return { rootId: row.rootEventId };
        return freshShipping.anchor(t, tenant, id);
      },
      draft: {
        identity(t, tenant, id) {
          bound(t, tenant);
          return freshShipping.draft.identity(t, tenant, id);
        },
      },
      snapshot: {
        async event(t, tenant, id) {
          bound(t, tenant);
          const saved = events.get(id);
          if (protectedEvents.has(id) && saved?.type === "shipping") return structuredClone(saved);
          const row = await freshShipping.snapshot.event(t, tenant, id);
          if (row && protectedEvents.has(id)) events.set(id, structuredClone(row));
          return row;
        },
        async root(t, tenant, id) {
          bound(t, tenant);
          const saved = shippingRoots.get(id);
          if (protectedShippingRoots.has(id) && saved) return structuredClone(saved);
          const row = await freshShipping.snapshot.root(t, tenant, id);
          if (row && protectedShippingRoots.has(id)) shippingRoots.set(id, structuredClone(row));
          return row;
        },
      },
    };
    const catalogReaders: UsCatalogReaders = {
      authorize,
      product(t, tenant, id) {
        bound(t, tenant);
        return freshUsCatalogReaders.product(t, tenant, id);
      },
      products(t, tenant, ids) {
        bound(t, tenant);
        return freshUsCatalogReaders.products(t, tenant, ids);
      },
    };
    const profileReaders: UsProductProfileReaders = {
      authorize,
      product(t, tenant, id, lock) {
        bound(t, tenant);
        return freshUsProductProfileReaders.product(t, tenant, id, lock);
      },
      products(t, tenant, ids) {
        bound(t, tenant);
        return freshUsProductProfileReaders.products(t, tenant, ids);
      },
      profile(t, tenant, id) {
        bound(t, tenant);
        return freshUsProductProfileReaders.profile(t, tenant, id);
      },
      profiles(t, tenant, ids) {
        bound(t, tenant);
        return freshUsProductProfileReaders.profiles(t, tenant, ids);
      },
    };
    const dependencies: UsDatasetCorrectedTerminalDependencies = {
      authorize,
      points,
      locks: {
        async correctedShipping(t, c, origin, known) {
          contextBound(t, c);
          await fresh.locks.correctedShipping(t, c, origin, known);
          protectedReceivingRoots.add(origin.input.receivingOrigin.rootId);
          protectedTransformationRoots.add(origin.created.id);
          // Exact successful revision membership protects the original root only.
          // The amended-current Receiving event deliberately remains fresh.
          protectedEvents.add(origin.input.receivingOrigin.rootId);
          protectedEvents.add(origin.created.id);
          for (const row of origin.inputLots) protectedLots.add(row.lotId);
          protectedLots.add(origin.outputLot.id);
          for (const row of known?.shipments ?? []) {
            protectedShippingRoots.add(row.created.id);
            protectedEvents.add(row.created.id);
          }
        },
        async correctedReferences(t, tenant, bindings) {
          bound(t, tenant);
          const rows = await fresh.locks.correctedReferences(t, tenant, bindings);
          for (const row of rows.parties) protectedParties.add(row.id);
          return rows;
        },
        async correctedDocuments(t, tenant, ids, definitions) {
          bound(t, tenant);
          const rows = await fresh.locks.correctedDocuments(t, tenant, ids, definitions);
          for (const row of rows) protectedDocuments.add(row.id);
          return rows;
        },
        receivingRoot(t, tenant, id) {
          bound(t, tenant);
          return fresh.locks.receivingRoot(t, tenant, id);
        },
        receivingRevision(t, tenant, id) {
          bound(t, tenant);
          return fresh.locks.receivingRevision(t, tenant, id);
        },
        transformationRevision(t, tenant, id) {
          bound(t, tenant);
          return fresh.locks.transformationRevision(t, tenant, id);
        },
        async referenceParents(t, tenant, bindings) {
          bound(t, tenant);
          const rows = await fresh.locks.referenceParents(t, tenant, bindings);
          for (const row of rows.parties) protectedParties.add(row.id);
          return rows;
        },
        receivingDocuments(t, tenant, ids) {
          bound(t, tenant);
          return fresh.locks.receivingDocuments(t, tenant, ids);
        },
        transformationDocuments(t, tenant, ids) {
          bound(t, tenant);
          return fresh.locks.transformationDocuments(t, tenant, ids);
        },
        shippingReferences(t, tenant, unit, bindings) {
          bound(t, tenant);
          return fresh.locks.shippingReferences(t, tenant, unit, bindings);
        },
        shippingDocuments(t, tenant, ids, definitions) {
          bound(t, tenant);
          return fresh.locks.shippingDocuments(t, tenant, ids, definitions);
        },
        transformation(t, c, target) {
          contextBound(t, c);
          return fresh.locks.transformation(t, c, target);
        },
        shipping(t, c, receiving, transformation, shipping) {
          contextBound(t, c);
          return fresh.locks.shipping(t, c, receiving, transformation, shipping);
        },
      },
      journal: {
        readHeaderInTransaction: (t, c) => {
          contextBound(t, c);
          return this.stores.journal.readHeaderInTransaction(t, c);
        },
        readStageInTransaction: (t, c, ...args) => {
          contextBound(t, c);
          return this.stores.journal.readStageInTransaction(t, c, ...args);
        },
        readStagesInTransaction: (t, c, ...args) => {
          contextBound(t, c);
          return this.stores.journal.readStagesInTransaction(t, c, ...args);
        },
      },
      master: {
        getPartyInTransaction: (t, tenant, actor, id) => {
          bound(t, tenant, actor);
          return readUsPartyCore(t, tenant, actor, id, masterReaders);
        },
        getPartiesInTransaction: (t, tenant, actor, ids) => {
          bound(t, tenant, actor);
          return readUsPartiesCore(t, tenant, actor, ids, masterReaders);
        },
        getLocationInTransaction: (t, tenant, actor, id) => {
          bound(t, tenant, actor);
          return readUsLocationCore(t, tenant, actor, id, masterReaders);
        },
        getLocationsInTransaction: (t, tenant, actor, ids) => {
          bound(t, tenant, actor);
          return readUsLocationsCore(t, tenant, actor, ids, masterReaders);
        },
      },
      catalog: {
        getProductsInTransaction: (t, tenant, actor, ids) => {
          bound(t, tenant, actor);
          return readUsProductsCore(t, tenant, actor, ids, catalogReaders);
        },
      },
      profiles: {
        getProfilesInTransaction: (t, tenant, actor, ids) => {
          bound(t, tenant, actor);
          return readUsProductProfilesCore(t, tenant, actor, ids, profileReaders);
        },
      },
      documents: {
        getDocumentInTransaction: (t, tenant, actor, id) => {
          bound(t, tenant, actor);
          return readUsReferenceDocumentCore(t, tenant, actor, id, documentReaders);
        },
      },
      lots: {
        getLotInTransaction: (t, tenant, actor, id) => {
          bound(t, tenant, actor);
          return readUsLotCore(t, tenant, actor, id, lotReaders);
        },
      },
      receiving: {
        getLiveRecordInTransaction: (t, tenant, actor, id) => {
          bound(t, tenant, actor);
          return readUsReceivingLiveRecordCore(t, tenant, actor, id, receivingReaders);
        },
        getLotReceivingBasisInTransaction: (t, tenant, actor, id, query) => {
          bound(t, tenant, actor);
          return readUsReceivingBasisCore(t, tenant, actor, id, query, receivingReaders);
        },
      },
      transformation: {
        getRecordInTransaction: (t, tenant, actor, id) => {
          bound(t, tenant, actor);
          return readUsTransformationRecordCore(t, tenant, actor, id, transformationReaders);
        },
      },
      shipping: {
        getRecordInTransaction: (t, tenant, actor, id) => {
          bound(t, tenant, actor);
          return readUsShippingRecordCore(t, tenant, actor, id, {
            authorize,
            history: shippingReaders,
          });
        },
      },
      shippingRevisions: (t, tenant, id, query) => {
        bound(t, tenant);
        return readShippingRevisionsCore(t, tenant, id, query, shippingReaders);
      },
    };
    try {
      await verifyUsDatasetCorrectedShippingCore(tx, checked, intent, receipt, dependencies, mode);
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
    capture: boolean,
  ): Promise<UsDatasetCorrectedShippingResult> {
    const unitKey = "correction_0001";
    try {
      const { journal } = this.stores;
      const datasetId = await this.db.transaction((tx) =>
        authorizeUsDatasetCorrectedShipping(tx, context, this.stores),
      );
      const header = { id: datasetId };
      const input = await readUsDatasetCorrectedShippingInput(journal, context, header.id);
      const checkedStage = (stage: UsDatasetStageRow | null) => {
        if (
          stage &&
          (stage.unitKey !== unitKey ||
            stage.stage !== "shipping" ||
            canonicalExportDigest(parseUsDatasetCorrectedShippingInput(stage.intent.input)) !==
              canonicalExportDigest(input))
        )
          throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
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
        throw datasetCorrectedShippingError(
          "us_dataset_corrected_shipping_prerequisite_incomplete",
        );
      let applied = false;
      const completed = await journal.runAtomicStage(
        context,
        header.id,
        stage.revision,
        stage.intent,
        {
          apply: async (tx, checked, intent) => {
            if (!capture)
              throw datasetCorrectedShippingError(
                "us_dataset_corrected_shipping_prerequisite_incomplete",
              );
            const prepared = await prepareUsDatasetCorrectedShipping(
              tx,
              checked,
              intent,
              { mode: "application" },
              this.stores,
            );
            const bindings = prepared.bindings;
            const bound = (rows: readonly { key: string; id: string }[], key: string) => {
              const row = rows.find((entry) => entry.key === key);
              if (!row)
                throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
              return row.id;
            };
            const shipments: UsDatasetShippingShipmentResult[] = [];
            // Fresh document/root rows are private inserts. All public receipt-owned
            // references and documents were retained before Cases support locks.
            for (const row of makeUsDatasetCorrectedShippingPlan(prepared.input)) {
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
                  throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
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
                      lotId: prepared.input.casesInput.outputLotId,
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
                throw datasetCorrectedShippingError("us_dataset_corrected_shipping_conflict");
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
              prepared.input.casesInput.outputLotId,
            );
            const result = parseUsDatasetCorrectedShippingResult({
              input: prepared.input,
              originLot: prepared.origin.outputLot,
              outputLotAfter,
              shipments,
            });
            applied = true;
            return {
              result,
              recordIds: usDatasetCorrectedShippingRecordIds(result),
              resultDigest: canonicalExportDigest(result),
            };
          },
          verify: (tx, checked, intent, receipt) =>
            this.#verifyTerminal(tx, checked, intent, receipt, applied ? "fresh" : "replay"),
        },
      );
      if (!completed.receipt)
        throw datasetCorrectedShippingError(
          "us_dataset_corrected_shipping_prerequisite_incomplete",
        );
      return parseUsDatasetCorrectedShippingResult(completed.receipt.result);
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
