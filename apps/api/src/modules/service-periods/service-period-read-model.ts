import { BadRequestException, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { ServicePeriodListQuery } from "./dto";

type Executor = Pick<Db, "select">;
type Period = typeof schema.servicePeriods.$inferSelect;

export type ServiceBalance = {
  included: number;
  externallyApproved: number;
  consumed: number;
  remaining: number;
};

export async function readServiceBalance(
  tx: Executor,
  period: Pick<Period, "id" | "tenantId" | "includedMinutes">,
): Promise<ServiceBalance> {
  const [[usage], [approval]] = await Promise.all([
    tx
      .select({
        value: sql<string>`coalesce(sum(${schema.serviceUsageEntries.allowanceMinutesDelta}), 0)`,
      })
      .from(schema.serviceUsageEntries)
      .where(
        and(
          eq(schema.serviceUsageEntries.tenantId, period.tenantId),
          eq(schema.serviceUsageEntries.servicePeriodId, period.id),
        ),
      ),
    tx
      .select({
        value: sql<string>`coalesce(sum(${schema.serviceExcessApprovals.minuteDelta}), 0)`,
      })
      .from(schema.serviceExcessApprovals)
      .where(
        and(
          eq(schema.serviceExcessApprovals.tenantId, period.tenantId),
          eq(schema.serviceExcessApprovals.servicePeriodId, period.id),
        ),
      ),
  ]);
  const consumed = Number(usage?.value ?? 0);
  const externallyApproved = Number(approval?.value ?? 0);
  return {
    included: period.includedMinutes,
    externallyApproved,
    consumed,
    remaining: period.includedMinutes + externallyApproved - consumed,
  };
}

async function readServiceBalances(
  db: Executor,
  periods: Period[],
): Promise<Map<string, ServiceBalance>> {
  if (periods.length === 0) return new Map();
  const ids = periods.map((period) => period.id);
  const [usageRows, approvalRows] = await Promise.all([
    db
      .select({
        periodId: schema.serviceUsageEntries.servicePeriodId,
        value: sql<string>`coalesce(sum(${schema.serviceUsageEntries.allowanceMinutesDelta}), 0)`,
      })
      .from(schema.serviceUsageEntries)
      .where(inArray(schema.serviceUsageEntries.servicePeriodId, ids))
      .groupBy(schema.serviceUsageEntries.servicePeriodId),
    db
      .select({
        periodId: schema.serviceExcessApprovals.servicePeriodId,
        value: sql<string>`coalesce(sum(${schema.serviceExcessApprovals.minuteDelta}), 0)`,
      })
      .from(schema.serviceExcessApprovals)
      .where(inArray(schema.serviceExcessApprovals.servicePeriodId, ids))
      .groupBy(schema.serviceExcessApprovals.servicePeriodId),
  ]);
  const usage = new Map(usageRows.map((row) => [row.periodId, Number(row.value)]));
  const approvals = new Map(approvalRows.map((row) => [row.periodId, Number(row.value)]));
  return new Map(
    periods.map((period) => {
      const consumed = usage.get(period.id) ?? 0;
      const externallyApproved = approvals.get(period.id) ?? 0;
      return [
        period.id,
        {
          included: period.includedMinutes,
          externallyApproved,
          consumed,
          remaining: period.includedMinutes + externallyApproved - consumed,
        },
      ];
    }),
  );
}

export function servicePeriodState(
  period: Pick<Period, "startsAt" | "endsAt">,
  at = new Date(),
): "upcoming" | "active" | "expired" {
  if (period.startsAt > at) return "upcoming";
  return period.endsAt <= at ? "expired" : "active";
}

export async function readServicePeriodDetail(db: Executor, id: string, at = new Date()) {
  return readServicePeriodDetailFor(db, id, undefined, at);
}

export async function readTenantServicePeriodDetail(
  db: Executor,
  tenantId: string,
  id: string,
  at = new Date(),
) {
  const detail = await readServicePeriodDetailFor(db, id, tenantId, at);
  return {
    id: detail.id,
    orderedServiceId: detail.orderedServiceId,
    catalogItemId: detail.catalogItemId,
    catalogVersionId: detail.catalogVersionId,
    nameRu: detail.nameRu,
    nameEn: detail.nameEn,
    startsAt: detail.startsAt,
    endsAt: detail.endsAt,
    state: detail.state,
    revision: detail.revision,
    balance: detail.balance,
    entries: detail.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      classification: entry.classification,
      originalEntryId: entry.originalEntryId,
      workReference: entry.workReference,
      description: entry.description,
      performedAt: entry.performedAt,
      postedAt: entry.postedAt,
      actualMinutesDelta: entry.actualMinutesDelta,
      allowanceMinutesDelta: entry.allowanceMinutesDelta,
    })),
  };
}

async function readServicePeriodDetailFor(
  db: Executor,
  id: string,
  tenantId: string | undefined,
  at: Date,
) {
  const [row] = await db
    .select({
      period: schema.servicePeriods,
      nameRu: schema.orderedServices.nameRu,
      nameEn: schema.orderedServices.nameEn,
    })
    .from(schema.servicePeriods)
    .innerJoin(
      schema.orderedServices,
      and(
        eq(schema.orderedServices.tenantId, schema.servicePeriods.tenantId),
        eq(schema.orderedServices.id, schema.servicePeriods.orderedServiceId),
      ),
    )
    .where(
      tenantId
        ? and(eq(schema.servicePeriods.id, id), eq(schema.servicePeriods.tenantId, tenantId))
        : eq(schema.servicePeriods.id, id),
    )
    .limit(1);
  if (!row) throw new NotFoundException({ code: "SERVICE_PERIOD_NOT_FOUND" });
  const [balance, entries, approvals] = await Promise.all([
    readServiceBalance(db, row.period),
    db
      .select({
        entry: schema.serviceUsageEntries,
        billingActId: schema.billingActServiceUsage.actId,
      })
      .from(schema.serviceUsageEntries)
      .leftJoin(
        schema.billingActServiceUsage,
        and(
          eq(schema.billingActServiceUsage.tenantId, schema.serviceUsageEntries.tenantId),
          eq(schema.billingActServiceUsage.serviceUsageEntryId, schema.serviceUsageEntries.id),
          isNull(schema.billingActServiceUsage.releasedAt),
        ),
      )
      .where(
        and(
          eq(schema.serviceUsageEntries.tenantId, row.period.tenantId),
          eq(schema.serviceUsageEntries.servicePeriodId, row.period.id),
        ),
      )
      .orderBy(schema.serviceUsageEntries.postedAt, schema.serviceUsageEntries.id),
    db
      .select()
      .from(schema.serviceExcessApprovals)
      .where(
        and(
          eq(schema.serviceExcessApprovals.tenantId, row.period.tenantId),
          eq(schema.serviceExcessApprovals.servicePeriodId, row.period.id),
        ),
      )
      .orderBy(schema.serviceExcessApprovals.postedAt, schema.serviceExcessApprovals.id),
  ]);
  return {
    ...summary(row.period, row.nameRu, row.nameEn, balance, at),
    invoiceId: row.period.invoiceId,
    invoiceLineId: row.period.invoiceLineId,
    paymentId: row.period.paymentId,
    entries: entries.map(({ entry, billingActId }) => ({
      id: entry.id,
      kind: entry.kind,
      classification: entry.classification,
      originalEntryId: entry.originalEntryId,
      workReference: entry.workReference,
      description: entry.description,
      internalNote: entry.internalNote,
      performedAt: entry.performedAt.toISOString(),
      postedAt: entry.postedAt.toISOString(),
      actualMinutesDelta: entry.actualMinutesDelta,
      allowanceMinutesDelta: entry.allowanceMinutesDelta,
      billingActId,
      actorPlatformUserId: entry.actorPlatformUserId,
      requestId: entry.requestId,
    })),
    approvals: approvals.map((approval) => ({
      id: approval.id,
      kind: approval.kind,
      originalApprovalId: approval.originalApprovalId,
      minuteDelta: approval.minuteDelta,
      externalReference: approval.externalReference,
      externalUrl: approval.externalUrl,
      approvedAt: approval.approvedAt.toISOString(),
      reason: approval.reason,
      actorPlatformUserId: approval.actorPlatformUserId,
      requestId: approval.requestId,
      postedAt: approval.postedAt.toISOString(),
    })),
  };
}

export async function listServicePeriods(
  db: Executor,
  query: ServicePeriodListQuery,
  now = new Date(),
) {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const predicates: SQL[] = [];
  if (query.tenantId) predicates.push(eq(schema.servicePeriods.tenantId, query.tenantId));
  if (query.catalogItemId)
    predicates.push(eq(schema.servicePeriods.catalogItemId, query.catalogItemId));
  if (query.from) predicates.push(gt(schema.servicePeriods.endsAt, new Date(query.from)));
  if (query.to) predicates.push(lt(schema.servicePeriods.startsAt, new Date(query.to)));
  if (query.state === "upcoming") predicates.push(gt(schema.servicePeriods.startsAt, now));
  if (query.state === "active")
    predicates.push(
      and(lte(schema.servicePeriods.startsAt, now), gt(schema.servicePeriods.endsAt, now))!,
    );
  if (query.state === "expired") predicates.push(lte(schema.servicePeriods.endsAt, now));
  if (cursor) {
    predicates.push(
      or(
        lt(schema.servicePeriods.startsAt, cursor.startsAt),
        and(
          eq(schema.servicePeriods.startsAt, cursor.startsAt),
          lt(schema.servicePeriods.id, cursor.id),
        ),
      )!,
    );
  }
  const rows = await db
    .select({
      period: schema.servicePeriods,
      nameRu: schema.orderedServices.nameRu,
      nameEn: schema.orderedServices.nameEn,
    })
    .from(schema.servicePeriods)
    .innerJoin(
      schema.orderedServices,
      and(
        eq(schema.orderedServices.tenantId, schema.servicePeriods.tenantId),
        eq(schema.orderedServices.id, schema.servicePeriods.orderedServiceId),
      ),
    )
    .where(predicates.length ? and(...predicates) : undefined)
    .orderBy(desc(schema.servicePeriods.startsAt), desc(schema.servicePeriods.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const balances = await readServiceBalances(
    db,
    page.map((row) => row.period),
  );
  const items = page.map((row) => {
    const balance = balances.get(row.period.id);
    if (!balance) throw new Error("service period balance missing");
    return summary(row.period, row.nameRu, row.nameEn, balance, now);
  });
  const last = page.at(-1)?.period;
  return {
    items,
    nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
  };
}

export async function listTenantServicePeriods(
  db: Executor,
  tenantId: string,
  query: Omit<ServicePeriodListQuery, "tenantId">,
  at = new Date(),
) {
  const result = await listServicePeriods(db, { ...query, tenantId }, at);
  return {
    ...result,
    items: result.items.map(({ tenantId: _tenantId, ...item }) => item),
  };
}

function summary(
  period: Period,
  nameRu: string,
  nameEn: string,
  balance: ServiceBalance,
  at = new Date(),
) {
  return {
    id: period.id,
    tenantId: period.tenantId,
    orderedServiceId: period.orderedServiceId,
    catalogItemId: period.catalogItemId,
    catalogVersionId: period.catalogVersionId,
    nameRu,
    nameEn,
    startsAt: period.startsAt.toISOString(),
    endsAt: period.endsAt.toISOString(),
    state: servicePeriodState(period, at),
    revision: period.revision,
    balance,
  };
}

function encodeCursor(period: Period): string {
  return Buffer.from(
    JSON.stringify({ startsAt: period.startsAt.toISOString(), id: period.id }),
  ).toString("base64url");
}

function decodeCursor(raw: string): { startsAt: Date; id: string } {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      !("startsAt" in value) ||
      typeof value.startsAt !== "string" ||
      !("id" in value) ||
      typeof value.id !== "string"
    )
      throw new Error("invalid");
    const startsAt = new Date(value.startsAt);
    if (!Number.isFinite(startsAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(value.id))
      throw new Error("invalid");
    return { startsAt, id: value.id };
  } catch {
    throw new BadRequestException({ code: "SERVICE_PERIOD_CURSOR_INVALID" });
  }
}
