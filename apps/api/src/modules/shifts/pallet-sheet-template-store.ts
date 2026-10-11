import { BadRequestException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import {
  createPalletSheetSnapshot,
  isPalletLabelTemplateEligible,
  parsePalletSheetSpec,
  type PalletSheetTemplateSnapshot,
} from "@markiro/domain";
import type { EligibilityDb } from "../label-templates/box-label-template-eligibility";
/** Caller holds the shift/product transaction; protect the selected template
 * revision with a share lock until its immutable snapshot is committed. */
export async function snapshotSelectedPalletSheet(
  db: EligibilityDb,
  tenantId: string,
  templateId: string,
  chzProductGroupCode: number | null,
): Promise<PalletSheetTemplateSnapshot> {
  const [row] = await db
    .select({
      id: schema.labelTemplates.id,
      name: schema.labelTemplates.name,
      revision: schema.labelTemplates.revision,
      spec: schema.labelTemplates.spec,
      format: schema.labelTemplates.format,
      purpose: schema.labelTemplates.purpose,
      enabled: schema.labelTemplates.enabled,
      chzProductGroupCodes: schema.labelTemplates.chzProductGroupCodes,
    })
    .from(schema.labelTemplates)
    .where(
      and(eq(schema.labelTemplates.tenantId, tenantId), eq(schema.labelTemplates.id, templateId)),
    )
    .for("share");
  if (
    !row ||
    row.format !== "pallet_sheet_v2" ||
    !isPalletLabelTemplateEligible(row, chzProductGroupCode)
  )
    throw new BadRequestException({
      code: "PALLET_SHEET_TEMPLATE_INELIGIBLE",
      message: "The selected A4 template is unavailable for this product",
    });
  try {
    return createPalletSheetSnapshot({
      id: row.id,
      name: row.name,
      revision: row.revision,
      spec: parsePalletSheetSpec(row.spec),
    });
  } catch {
    throw new BadRequestException({
      code: "PALLET_SHEET_TEMPLATE_INVALID",
      message: "The selected A4 template cannot be read",
    });
  }
}
