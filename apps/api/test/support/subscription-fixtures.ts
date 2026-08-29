import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";

export interface ManagedSubscriptionFixture {
  tenantId: string;
  planVersionId: string;
  subscriptionId: string;
}

export async function createOrganization(db: Db, tenantId: string = randomUUID()): Promise<string> {
  await db.insert(schema.organization).values({
    id: tenantId,
    name: `Subscription fixture ${tenantId}`,
    slug: `subscription-${tenantId}`,
    createdAt: new Date(),
  });
  return tenantId;
}

export async function createPublishedPlan(
  db: Db,
  input: {
    maxLines: number | null;
    maxStations: number | null;
    maxKiosks: number | null;
    maxCabinetUsers: number | null;
    labelEditorEnabled?: boolean;
    publicApiEnabled?: boolean;
    palletsEnabled?: boolean;
  },
): Promise<string> {
  const itemId = randomUUID();
  const versionId = randomUUID();
  await db.insert(schema.catalogItems).values({
    id: itemId,
    code: `plan-${itemId}`,
    nameRu: `Plan ${itemId}`,
    nameEn: `Plan ${itemId}`,
    kind: "plan",
  });
  await db.insert(schema.catalogItemVersions).values({
    id: versionId,
    catalogItemId: itemId,
    kind: "plan",
    version: 1,
    nameRu: `Plan ${itemId}`,
    nameEn: `Plan ${itemId}`,
    unit: "month",
    billingMode: "recurring",
    billingPeriod: "month",
    unitPrice: "1000.00",
    vatRate: "20.00",
    vatIncluded: true,
  });
  await db.insert(schema.planEntitlements).values({
    catalogVersionId: versionId,
    maxLines: input.maxLines,
    maxStations: input.maxStations,
    maxKiosks: input.maxKiosks,
    maxCabinetUsers: input.maxCabinetUsers,
    labelEditorEnabled: input.labelEditorEnabled ?? false,
    publicApiEnabled: input.publicApiEnabled ?? false,
    palletsEnabled: input.palletsEnabled ?? false,
  });
  await db
    .update(schema.catalogItemVersions)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(schema.catalogItemVersions.id, versionId));
  return versionId;
}

export async function createPublishedAddon(
  db: Db,
  effects: Array<
    | { entitlementKey: "lines" | "stations" | "kiosks" | "cabinetUsers"; increment: number }
    | { entitlementKey: "labelEditor" | "publicApi" | "pallets" }
  >,
): Promise<string> {
  const itemId = randomUUID();
  const versionId = randomUUID();
  await db.insert(schema.catalogItems).values({
    id: itemId,
    code: `addon-${itemId}`,
    nameRu: `Addon ${itemId}`,
    nameEn: `Addon ${itemId}`,
    kind: "addon",
  });
  await db.insert(schema.catalogItemVersions).values({
    id: versionId,
    catalogItemId: itemId,
    kind: "addon",
    version: 1,
    nameRu: `Addon ${itemId}`,
    nameEn: `Addon ${itemId}`,
    unit: "month",
    billingMode: "recurring",
    billingPeriod: "month",
    unitPrice: "100.00",
    vatRate: "20.00",
    vatIncluded: true,
  });
  await db.insert(schema.addonEntitlements).values(
    effects.map((effect) =>
      "increment" in effect
        ? {
            catalogVersionId: versionId,
            entitlementKey: effect.entitlementKey,
            quotaIncrement: effect.increment,
          }
        : {
            catalogVersionId: versionId,
            entitlementKey: effect.entitlementKey,
            featureEnabled: true,
          },
    ),
  );
  await db
    .update(schema.catalogItemVersions)
    .set({ status: "published", publishedAt: new Date() })
    .where(eq(schema.catalogItemVersions.id, versionId));
  return versionId;
}

export async function createManagedSubscription(
  db: Db,
  input: {
    tenantId?: string;
    planVersionId?: string;
    maxLines?: number | null;
    maxStations?: number | null;
    maxKiosks?: number | null;
    maxCabinetUsers?: number | null;
    status?: "pending_activation" | "scheduled" | "trial" | "active";
    startsAt?: Date | null;
    endsAt?: Date | null;
  } = {},
): Promise<ManagedSubscriptionFixture> {
  const tenantId = input.tenantId ?? (await createOrganization(db));
  const planVersionId =
    input.planVersionId ??
    (await createPublishedPlan(db, {
      maxLines: input.maxLines === undefined ? 1 : input.maxLines,
      maxStations: input.maxStations === undefined ? 1 : input.maxStations,
      maxKiosks: input.maxKiosks === undefined ? 1 : input.maxKiosks,
      maxCabinetUsers: input.maxCabinetUsers === undefined ? 1 : input.maxCabinetUsers,
    }));
  const subscriptionId = randomUUID();
  await db.insert(schema.tenantSubscriptions).values({
    id: subscriptionId,
    tenantId,
    planVersionId,
    status: input.status ?? "active",
    startsAt: input.startsAt === undefined ? new Date(Date.now() - 60_000) : input.startsAt,
    endsAt: input.endsAt === undefined ? new Date(Date.now() + 3_600_000) : input.endsAt,
    source: "manual",
  });
  return { tenantId, planVersionId, subscriptionId };
}
