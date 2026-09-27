import type { Db } from "@markiro/db";
import type {
  CaseLinkResult,
  CaseUnlinkResult,
  CaseListResult,
  CaseLookupResult,
} from "@markiro/platform-contracts";
import { linkCases, unlinkCase } from "./us-case-commands";
import { listCases, lookupCase } from "./us-case-reads";

/** Internal US-only manual command boundary; synthetic provenance is fixture/seed-owned. */
export class UsCaseStore {
  constructor(private readonly db: Db) {}
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
}
