import {
  assertDuplicateTemplate,
  DomainError,
  labelTemplateSpecSchema,
  labelTemplateUsesField,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { z } from "zod";

import type { TemplatePurpose, WarehouseSubjectKind } from "../../host/protocol.js";
import { templateFitsSlot } from "../../lib/template-eligibility.js";
import type { LocalExecutor } from "../../local/executor.js";
import type { WarehouseTemplates } from "./warehouse-store.js";

/** The template purpose of each kind of label printed again. */
export const KIND_PURPOSE: Record<WarehouseSubjectKind, TemplatePurpose> = {
  unit: "product_duplicate",
  box: "box",
  pallet: "pallet",
};

/** A template of the copies, with its layout read (`null` — it does not read). */
export interface WarehouseTemplate {
  id: string;
  name: string;
  purpose: TemplatePurpose;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
  rev: number;
  spec: LabelTemplateSpec | null;
}

const templateRow = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.enum(["box", "pallet", "product_duplicate"]),
  enabled: z.number(),
  category_codes: z.string().nullable(),
  spec: z.string(),
  rev: z.number().int(),
});
const codesSchema = z.array(z.number().int());
const orgRow = z.object({
  default_duplicate_template_id: z.string().nullable(),
  default_box_template_id: z.string().nullable(),
  default_pallet_template_id: z.string().nullable(),
});

function readJson<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The templates of the three purposes in this pairing's copies, by name (the reference table is small). */
export async function readWarehouseTemplates(local: LocalExecutor): Promise<WarehouseTemplate[]> {
  const found = await local.query(
    "SELECT id, name, purpose, enabled, category_codes, spec, rev FROM ref_templates " +
      "WHERE purpose IN ('product_duplicate', 'box', 'pallet') ORDER BY name, id",
    [],
    templateRow,
  );
  return found.map((row) => {
    const codes = row.category_codes === null ? null : readJson(row.category_codes, codesSchema);
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      enabled: row.enabled === 1,
      chzProductGroupCodes: codes,
      rev: row.rev,
      // A category list that does not read must not widen the template to every
      // category: the template is then unreadable and prints nothing.
      spec:
        row.category_codes !== null && codes === null
          ? null
          : readJson(row.spec, labelTemplateSpecSchema),
    };
  });
}

/** The organization's default template of each kind (`ref_org`), or none. */
export async function readOrgDefaults(local: LocalExecutor): Promise<WarehouseTemplates> {
  const [org] = await local.query(
    "SELECT default_duplicate_template_id, default_box_template_id, default_pallet_template_id " +
      "FROM ref_org",
    [],
    orgRow,
  );
  return {
    unit: org?.default_duplicate_template_id ?? null,
    box: org?.default_box_template_id ?? null,
    pallet: org?.default_pallet_template_id ?? null,
  };
}

/** A template the operator may choose for `kind`: of its purpose, enabled, with a layout that reads. */
export function isChoosable(template: WarehouseTemplate, kind: WarehouseSubjectKind): boolean {
  return template.purpose === KIND_PURPOSE[kind] && template.enabled && template.spec !== null;
}

/**
 * The templates a new session starts with (decision Р8): the organization's default
 * when it is choosable, otherwise the only choosable one, otherwise none.
 */
export function initialTemplates(
  templates: readonly WarehouseTemplate[],
  defaults: WarehouseTemplates,
): WarehouseTemplates {
  const pick = (kind: WarehouseSubjectKind): string | null => {
    const choosable = templates.filter((template) => isChoosable(template, kind));
    const preferred = choosable.find((template) => template.id === defaults[kind]);
    if (preferred !== undefined) return preferred.id;
    const [only, ...others] = choosable;
    return only !== undefined && others.length === 0 ? only.id : null;
  };
  return { unit: pick("unit"), box: pick("box"), pallet: pick("pallet") };
}

/** Whether the chosen template prints this record, and why not. */
export type TemplateCheck =
  | { kind: "ok"; template: WarehouseTemplate; spec: LabelTemplateSpec }
  | { kind: "no_template" }
  | { kind: "template_unavailable" }
  | { kind: "template_unfit" };

/**
 * The chosen template of `kind` for a record of product group `group`: chosen,
 * still enabled with a readable layout, covering the group, and a layout of its
 * purpose — a unit's with its one GS1 DataMatrix of the full code and no SSCC, a
 * box's or a pallet's with the SSCC and no unit code. No other template is put
 * in its place (decision Р8).
 */
export function checkTemplate(
  templates: readonly WarehouseTemplate[],
  chosenId: string | null,
  kind: WarehouseSubjectKind,
  group: number | null,
): TemplateCheck {
  if (chosenId === null) return { kind: "no_template" };
  const template = templates.find((candidate) => candidate.id === chosenId);
  if (template === undefined || !isChoosable(template, kind) || template.spec === null) {
    return { kind: "template_unavailable" };
  }
  const purpose = KIND_PURPOSE[kind];
  if (!templateFitsSlot(template, { purpose, chzProductGroupCode: group })) {
    return { kind: "template_unfit" };
  }
  const { spec } = template;
  if (kind === "unit") {
    try {
      assertDuplicateTemplate(spec);
    } catch (error) {
      if (error instanceof DomainError) return { kind: "template_unfit" };
      throw error;
    }
  } else if (!labelTemplateUsesField(spec, "sscc") || labelTemplateUsesField(spec, "km.code")) {
    return { kind: "template_unfit" };
  }
  return { kind: "ok", template, spec };
}
