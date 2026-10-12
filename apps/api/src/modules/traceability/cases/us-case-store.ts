import type { Db } from "@markiro/db";
import type {
  CaseLinkResult,
  CaseUnlinkResult,
  CaseListResult,
  CaseLookupResult,
} from "@markiro/platform-contracts";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { linkCases, linkCasesInTransaction, unlinkCase } from "./us-case-commands";
import { listCases, lookupCase } from "./us-case-reads";
import { linkDemoCasesInTransaction } from "./us-case-demo-command";
import type { UsDatasetContext } from "../demo/us-dataset-contract";
import { UsDatasetJournalStore } from "../demo/us-dataset-journal";
import { usSixMonthDefinition } from "../demo/us-six-month-definition";
import { UsMasterDataStore } from "../master-data/us-master-data-store";
import { UsCatalogStore } from "../catalog/us-catalog-store";
import { UsProductProfileStore } from "../products/us-product-profile-store";
import { UsReferenceDocumentStore } from "../documents/us-reference-document-store";
import { UsLotStore } from "../lots/us-lot-store";
import { UsReceivingStore } from "../receiving/us-receiving-store";
import { UsTransformationStore } from "../transformation/us-transformation-store";

/** Internal US-only manual command boundary; synthetic provenance is fixture/seed-owned. */
export class UsCaseStore {
  constructor(private readonly db: Db) {}
  linkDemoInTransaction(
    tx: UsMasterDataTransaction,
    context: UsDatasetContext,
    datasetId: string,
    unitKey: string,
    requestId: string,
  ): Promise<CaseLinkResult> {
    return linkDemoCasesInTransaction(tx, context, datasetId, unitKey, requestId, {
      journal: new UsDatasetJournalStore(this.db, usSixMonthDefinition),
      master: new UsMasterDataStore(this.db),
      catalog: new UsCatalogStore(this.db),
      profiles: new UsProductProfileStore(this.db),
      documents: new UsReferenceDocumentStore(this.db),
      lots: new UsLotStore(this.db),
      receiving: new UsReceivingStore(this.db),
      transformation: new UsTransformationStore(this.db),
    });
  }
  list(
    tenantId: string,
    actorUserId: string,
    lotId: unknown,
    query: unknown,
  ): Promise<CaseListResult> {
    return listCases(this.db, tenantId, actorUserId, lotId, query);
  }
  lookup(tenantId: string, actorUserId: string, query: unknown): Promise<CaseLookupResult> {
    return lookupCase(this.db, tenantId, actorUserId, query);
  }
  link(
    tenantId: string,
    actorUserId: string,
    lotId: unknown,
    input: unknown,
    requestId: string,
  ): Promise<CaseLinkResult> {
    return linkCases(this.db, tenantId, actorUserId, lotId, input, requestId);
  }
  unlink(
    tenantId: string,
    actorUserId: string,
    lotId: unknown,
    linkId: unknown,
    input: unknown,
    requestId: string,
  ): Promise<CaseUnlinkResult> {
    return unlinkCase(this.db, tenantId, actorUserId, lotId, linkId, input, requestId);
  }
  linkInTransaction(
    tx: UsMasterDataTransaction,
    tenantId: string,
    actorUserId: string,
    id: unknown,
    input: unknown,
    requestId: string,
  ): Promise<CaseLinkResult> {
    return linkCasesInTransaction(tx, tenantId, actorUserId, id, input, requestId);
  }
}
