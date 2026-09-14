import { ConflictException } from "@nestjs/common";
import { resolveCommercialPeriod } from "@markiro/domain";
import { schema, type Db } from "@markiro/db";
import {
  commercialLineTermsV4Schema,
  commercialPeriodSchema,
  type CommercialLineTermsV4,
} from "@markiro/platform-contracts";
import { and, desc, eq, sql } from "drizzle-orm";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InvoiceLine = typeof schema.invoiceLines.$inferSelect;
type BillingPayment = typeof schema.billingPayments.$inferSelect;
type RecurringServiceTerms = Extract<CommercialLineTermsV4, { version: 2 }>;

export type ServicePeriodActivationResult = {
  kind: "service_period";
  id: string;
  orderedServiceId: string;
  catalogItemId: string;
  catalogVersionId: string;
  startsAt: string;
  endsAt: string;
  includedMinutes: number;
  revision: number;
};

export function recurringServiceTerms(line: InvoiceLine): RecurringServiceTerms | null {
  const parsed = commercialLineTermsV4Schema.safeParse(line.commercialTerms);
  return line.kind === "service" && parsed.success && parsed.data.version === 2
    ? parsed.data
    : null;
}

export async function activatePaidServicePeriod(
  tx: Transaction,
  input: {
    tenantId: string;
    invoiceId: string;
    line: InvoiceLine;
    payment: BillingPayment;
    operationAt: Date;
  },
): Promise<ServicePeriodActivationResult> {
  const terms = recurringServiceTerms(input.line);
  if (!terms || !input.line.catalogVersionId)
    throw new ConflictException({ code: "recurring_service_terms_missing" });
  const [version] = await tx
    .select({ catalogItemId: schema.catalogItemVersions.catalogItemId })
    .from(schema.catalogItemVersions)
    .where(eq(schema.catalogItemVersions.id, input.line.catalogVersionId))
    .limit(1);
  if (!version) throw new ConflictException({ code: "catalog_version_missing" });

  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`service-period:${input.tenantId}:${version.catalogItemId}`}, 0))`,
  );
  const [existing] = await tx
    .select()
    .from(schema.servicePeriods)
    .where(
      and(
        eq(schema.servicePeriods.tenantId, input.tenantId),
        eq(schema.servicePeriods.invoiceLineId, input.line.id),
      ),
    )
    .limit(1);
  if (existing) return activationResult(existing);

  const [latest] = await tx
    .select()
    .from(schema.servicePeriods)
    .where(
      and(
        eq(schema.servicePeriods.tenantId, input.tenantId),
        eq(schema.servicePeriods.catalogItemId, version.catalogItemId),
      ),
    )
    .orderBy(desc(schema.servicePeriods.endsAt), desc(schema.servicePeriods.id))
    .limit(1);
  const previousAnchor = latest ? commercialPeriodSchema.parse(latest.renewalAnchor) : null;
  const period = resolveCommercialPeriod({
    billingPeriod: "month",
    anchorAt: previousAnchor?.anchorAt ?? input.operationAt.toISOString(),
    cycle: previousAnchor ? previousAnchor.cycle + 1 : 0,
  });

  const [ordered] = await tx
    .insert(schema.orderedServices)
    .values({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      invoiceLineId: input.line.id,
      billingPaymentId: input.payment.id,
      catalogVersionId: input.line.catalogVersionId,
      nameRu: input.line.nameRu,
      nameEn: input.line.nameEn,
      descriptionRu: input.line.descriptionRu,
      descriptionEn: input.line.descriptionEn,
      quantity: input.line.quantity,
      unit: input.line.unit,
      orderedAt: input.payment.paidAt,
    })
    .returning();
  if (!ordered) throw new ConflictException({ code: "ordered_service_creation_failed" });
  const [created] = await tx
    .insert(schema.servicePeriods)
    .values({
      tenantId: input.tenantId,
      orderedServiceId: ordered.id,
      catalogItemId: version.catalogItemId,
      catalogVersionId: input.line.catalogVersionId,
      invoiceId: input.invoiceId,
      invoiceLineId: input.line.id,
      paymentId: input.payment.id,
      startsAt: new Date(period.startsAt),
      endsAt: new Date(period.endsAt),
      billingTimezone: period.billingTimezone,
      renewalAnchor: period,
      commercialSnapshot: terms,
      allowanceSnapshot: {
        includedMinutes: terms.serviceTerms.includedMinutes,
        carryover: terms.serviceTerms.carryover,
        excessPolicy: terms.serviceTerms.excessPolicy,
      },
      includedMinutes: terms.serviceTerms.includedMinutes,
    })
    .returning();
  if (!created) throw new ConflictException({ code: "service_period_creation_failed" });
  return activationResult(created);
}

function activationResult(
  period: typeof schema.servicePeriods.$inferSelect,
): ServicePeriodActivationResult {
  return {
    kind: "service_period",
    id: period.id,
    orderedServiceId: period.orderedServiceId,
    catalogItemId: period.catalogItemId,
    catalogVersionId: period.catalogVersionId,
    startsAt: period.startsAt.toISOString(),
    endsAt: period.endsAt.toISOString(),
    includedMinutes: period.includedMinutes,
    revision: period.revision,
  };
}
