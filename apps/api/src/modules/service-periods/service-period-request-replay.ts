import { ConflictException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { platformServicePeriodContracts } from "@markiro/platform-contracts";
import { platformBillingPayloadHash } from "../platform-billing-idempotency";
import type { ServicePeriodMutationResult } from "./dto";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function serviceRequestHash(payload: unknown): string {
  return platformBillingPayloadHash(payload);
}

export async function readServiceRequestReplay(
  tx: Transaction,
  tenantId: string,
  requestId: string,
  requestHash: string,
): Promise<ServicePeriodMutationResult | null> {
  const [[usage], [approval]] = await Promise.all([
    tx
      .select({
        requestHash: schema.serviceUsageEntries.requestHash,
        response: schema.serviceUsageEntries.response,
      })
      .from(schema.serviceUsageEntries)
      .where(
        and(
          eq(schema.serviceUsageEntries.tenantId, tenantId),
          eq(schema.serviceUsageEntries.requestId, requestId),
        ),
      )
      .limit(1),
    tx
      .select({
        requestHash: schema.serviceExcessApprovals.requestHash,
        response: schema.serviceExcessApprovals.response,
      })
      .from(schema.serviceExcessApprovals)
      .where(
        and(
          eq(schema.serviceExcessApprovals.tenantId, tenantId),
          eq(schema.serviceExcessApprovals.requestId, requestId),
        ),
      )
      .limit(1),
  ]);
  const existing = usage ?? approval;
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new ConflictException({ code: "SERVICE_REQUEST_CONFLICT" });
  }
  return platformServicePeriodContracts.postUsage.response.parse(existing.response);
}
