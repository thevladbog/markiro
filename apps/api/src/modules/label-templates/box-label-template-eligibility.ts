import { BadRequestException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { resolveBoxLabelTemplateDefault, type BoxLabelTemplateDefault } from "@markiro/domain";

/**
 * Database-backed helpers over the domain's box-label eligibility rules.
 * Plain functions (no Nest DI) so label-templates, org-profile, shifts and
 * inventories can share them from inside their own transactions.
 */
export type EligibilityDb = Pick<Db, "select">;

export interface LabelTemplateEligibilityRow {
  id: string;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
}

const ELIGIBILITY_SELECTION = {
  id: schema.labelTemplates.id,
  enabled: schema.labelTemplates.enabled,
  chzProductGroupCodes: schema.labelTemplates.chzProductGroupCodes,
};

/** Same-tenant template with its selection metadata, or null. `lock` runs inside a transaction. */
export async function findLabelTemplateEligibility(
  db: EligibilityDb,
  tenantId: string,
  templateId: string,
  lock?: "share" | "update",
): Promise<LabelTemplateEligibilityRow | null> {
  const where = and(
    eq(schema.labelTemplates.tenantId, tenantId),
    eq(schema.labelTemplates.id, templateId),
  );
  const rows = lock
    ? await db.select(ELIGIBILITY_SELECTION).from(schema.labelTemplates).where(where).for(lock)
    : await db.select(ELIGIBILITY_SELECTION).from(schema.labelTemplates).where(where);
  return rows[0] ?? null;
}

/** Category default (when the product has a group) → organisation default → none. */
export async function resolveDefaultBoxLabelTemplate(
  db: EligibilityDb,
  tenantId: string,
  chzProductGroupCode: number | null,
): Promise<BoxLabelTemplateDefault> {
  const [profile] = await db
    .select({ defaultBoxLabelTemplateId: schema.orgProfiles.defaultBoxLabelTemplateId })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  let categoryDefaultId: string | null = null;
  if (chzProductGroupCode !== null) {
    const [category] = await db
      .select({ templateId: schema.orgBoxLabelTemplateDefaults.templateId })
      .from(schema.orgBoxLabelTemplateDefaults)
      .where(
        and(
          eq(schema.orgBoxLabelTemplateDefaults.tenantId, tenantId),
          eq(schema.orgBoxLabelTemplateDefaults.chzProductGroupCode, chzProductGroupCode),
        ),
      );
    categoryDefaultId = category?.templateId ?? null;
  }
  return resolveBoxLabelTemplateDefault({
    categoryDefaultId,
    organizationDefaultId: profile?.defaultBoxLabelTemplateId ?? null,
  });
}

export interface LabelTemplateDefaultUsage {
  organizationDefault: boolean;
  /** Product-group codes whose category default is this template, ascending. */
  categoryDefaults: number[];
}

export async function findLabelTemplateDefaultUsage(
  db: EligibilityDb,
  tenantId: string,
  templateId: string,
): Promise<LabelTemplateDefaultUsage> {
  const [profile] = await db
    .select({ defaultBoxLabelTemplateId: schema.orgProfiles.defaultBoxLabelTemplateId })
    .from(schema.orgProfiles)
    .where(eq(schema.orgProfiles.tenantId, tenantId));
  const rows = await db
    .select({ code: schema.orgBoxLabelTemplateDefaults.chzProductGroupCode })
    .from(schema.orgBoxLabelTemplateDefaults)
    .where(
      and(
        eq(schema.orgBoxLabelTemplateDefaults.tenantId, tenantId),
        eq(schema.orgBoxLabelTemplateDefaults.templateId, templateId),
      ),
    );
  return {
    organizationDefault: profile?.defaultBoxLabelTemplateId === templateId,
    categoryDefaults: rows.map((row) => row.code).sort((a, b) => a - b),
  };
}

/** 400 with the offending codes when any is missing from `chz_product_groups`. */
export async function assertKnownProductGroupCodes(
  db: EligibilityDb,
  codes: readonly number[],
): Promise<void> {
  if (codes.length === 0) return;
  const rows = await db
    .select({ code: schema.chzProductGroups.code })
    .from(schema.chzProductGroups)
    .where(inArray(schema.chzProductGroups.code, [...codes]));
  const known = new Set(rows.map((row) => row.code));
  const unknown = codes.filter((code) => !known.has(code));
  if (unknown.length > 0) {
    throw new BadRequestException({
      code: "CHZ_PRODUCT_GROUP_UNKNOWN",
      message: `Unknown Chestny ZNAK product group codes: ${unknown.join(", ")}`,
      codes: unknown,
    });
  }
}
