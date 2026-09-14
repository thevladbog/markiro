import { ForbiddenException, Injectable } from "@nestjs/common";
import { schema } from "@markiro/db";
import {
  ENTITLEMENT_REGISTRY_VERSION,
  type PublicApiScope,
  type EntitlementOperationId,
} from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import { evaluateEntitlementOperation } from "../../subscriptions/entitlement-projection";
import { QUANTITATIVE_ENTITLEMENT_KEYS } from "../../subscriptions/entitlements.types";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import type { PublicApiTransaction } from "./public-api.types";

export const PUBLIC_API_OPERATIONS = {
  "catalog.read": {
    scope: "catalog.products.read",
    entitlementOperation: "public.catalog.read.v1",
  },
  "inventory.read": { scope: "inventory.read", entitlementOperation: "public.inventory.read.v1" },
  "inventory.create": {
    scope: "inventory.prepare",
    entitlementOperation: "public.inventory.create.v1",
  },
  "inventory.import": {
    scope: "inventory.prepare",
    entitlementOperation: "public.inventory.import.v1",
  },
  "inventory.snapshot": {
    scope: "inventory.prepare",
    entitlementOperation: "public.inventory.snapshot.v1",
  },
  "inventory.start": {
    scope: "inventory.start",
    entitlementOperation: "public.inventory.start.v1",
  },
} as const satisfies Record<
  string,
  { scope: PublicApiScope; entitlementOperation: EntitlementOperationId }
>;
export type PublicApiOperation = keyof typeof PUBLIC_API_OPERATIONS;
@Injectable()
export class PublicApiAdmissionService {
  constructor(private readonly entitlements: EntitlementsService) {}
  /** Key row first (caller), then existing quota/timeline locks, revision, receipt, business owner.
   * Revision triggers acquire the revision last after their existing quota/timeline locks.
   * No second connection or fail-open shadow capture is permitted here. */
  async assertAllowed(
    tx: PublicApiTransaction,
    tenantId: string,
    operation: PublicApiOperation,
  ): Promise<Record<string, unknown>> {
    for (const key of QUANTITATIVE_ENTITLEMENT_KEYS)
      await this.entitlements.withQuotaLock(tx, tenantId, key, () => Promise.resolve());
    await lockTenantSubscriptionTimeline(tx, tenantId);
    await tx.insert(schema.entitlementRevisions).values({ tenantId }).onConflictDoNothing();
    await tx
      .select()
      .from(schema.entitlementRevisions)
      .where(eq(schema.entitlementRevisions.tenantId, tenantId))
      .for("share");
    const facts = await this.entitlements.resolveSnapshotInTransaction(tenantId, tx);
    const operationId = PUBLIC_API_OPERATIONS[operation].entitlementOperation;
    const decision = evaluateEntitlementOperation(facts.snapshot, operationId);
    if (decision.outcome !== "allow")
      throw new ForbiddenException({
        code: "PUBLIC_API_NOT_ENTITLED",
        reasons: decision.reasonCodes,
      });
    return {
      operationId,
      registryVersion: ENTITLEMENT_REGISTRY_VERSION,
      revision: facts.snapshot.revision,
      usageRevision: facts.snapshot.usageRevision,
      asOf: facts.snapshot.asOf,
      policyFingerprint: facts.policyFingerprint,
      versionIds: facts.versionIds,
    };
  }
}
