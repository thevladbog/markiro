import { z } from "zod";
import { ApiProperty, type SchemaObject } from "@nestjs/swagger";
import {
  DomainError,
  labelTemplateSpecSchema,
  parseStoredLabelTemplate,
  isPalletSheetSpec,
  palletSheetSpecSchema,
  sheetNodeSchema,
  type SheetNode,
  type StoredLabelTemplateSpec,
  type LabelTemplatePurpose,
} from "@markiro/domain";
import { zodApiSchema } from "../../lib/openapi";

/**
 * Validates `spec` against the domain model (`parseLabelTemplate`). On
 * failure, maps every issue from the DomainError's `cause` array (see
 * `packages/domain/src/labels/model.ts`) into a zod issue rooted at
 * `["spec", ...path]` via `ctx.addIssue` -- this lets `ZodValidationPipe`
 * (apps/api/src/zod.pipe.ts) surface the FULL multi-issue list in the 400
 * body, exactly like a native zod failure, instead of collapsing to a
 * single message. Returns `z.NEVER` when issues were added (the parse fails
 * overall regardless of this return value once ctx.addIssue has been
 * called), or the parsed, typed spec otherwise.
 */
function parseSpecOrAddIssues(spec: unknown, ctx: z.RefinementCtx): StoredLabelTemplateSpec {
  try {
    if (Buffer.byteLength(JSON.stringify(spec) ?? "", "utf8") > 256 * 1024)
      throw new DomainError("LABEL_CODE_TOO_LARGE", "Template JSON exceeds 256 KiB");
    return parseStoredLabelTemplate(spec);
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }
    const issues = (error.cause as Array<{ path: string; message: string }> | undefined) ?? [];
    if (issues.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error.message, path: ["spec"] });
    } else {
      for (const issue of issues) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path ? ["spec", ...issue.path.split(".")] : ["spec"],
        });
      }
    }
    return z.NEVER;
  }
}

/**
 * Every value of the domain's `LabelTemplatePurpose`, including `pallet`
 * (06d). A tenant seeded with the one stock pallet label must be able to mint
 * its own -- the shift form offers a pallet-template picker, and a picker
 * over exactly one immutable row is not a choice. `pallet` was excluded here
 * until 06d closed the loop, which made both "Создать копию" on the stock
 * template and any second pallet layout an opaque 400.
 *
 * Widening the INPUT enum does not widen where a purpose is accepted:
 * `ShiftsService.assertBoxTemplateEligible`/`assertPalletTemplateEligible`
 * still refuse a template whose purpose is not the one that slot needs, and
 * `LabelTemplatesService.updateLabelTemplate` still refuses to change an
 * existing template's purpose at all.
 */
const formatSchema = z.enum(["label_v1", "pallet_sheet_v2"]);
const purposeSchema = z.enum(["box", "product_duplicate", "pallet"]);

/** Non-empty, duplicate-free ЧЗ product-group codes; `null` means every category. */
const productGroupCodesSchema = z
  .array(z.number().int().positive())
  .min(1, "chzProductGroupCodes must list at least one product group")
  .refine((codes) => new Set(codes).size === codes.length, {
    message: "chzProductGroupCodes must not repeat a code",
  })
  .nullable();

export const listLabelTemplatesQuerySchema = z.object({
  /** `true` (default) hides disabled templates so every picker is safe by default; the library asks for `all`. */
  enabled: z.enum(["true", "false", "all"]).default("true"),
});
export type ListLabelTemplatesQueryDto = z.infer<typeof listLabelTemplatesQuerySchema>;

/** POST /label-templates schema. `spec` is validated by @markiro/domain's parseLabelTemplate. */
export const createLabelTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    spec: z.unknown(),
    purpose: purposeSchema.default("box"),
    format: formatSchema.optional(),
    enabled: z.boolean().optional(),
    chzProductGroupCodes: productGroupCodesSchema.optional(),
  })
  .transform((data, ctx) => {
    const spec = parseSpecOrAddIssues(data.spec, ctx);
    const format: "label_v1" | "pallet_sheet_v2" = isPalletSheetSpec(spec)
      ? "pallet_sheet_v2"
      : "label_v1";
    if (data.format !== undefined && data.format !== format)
      ctx.addIssue({ code: "custom", path: ["format"], message: "Format does not match spec" });
    if (format === "pallet_sheet_v2" && data.purpose !== "pallet")
      ctx.addIssue({
        code: "custom",
        path: ["purpose"],
        message: "A4 sheets are pallet templates",
      });
    return {
      name: data.name,
      purpose: data.purpose,
      spec,
      format,
      enabled: data.enabled ?? true,
      chzProductGroupCodes: data.chzProductGroupCodes ?? null,
    };
  });

export type CreateLabelTemplateDto = z.infer<typeof createLabelTemplateSchema>;

/** PATCH /label-templates/:id schema -- partial update, preserves untouched fields. */
export const updateLabelTemplateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    spec: z.unknown().optional(),
    purpose: purposeSchema.optional(),
    format: formatSchema.optional(),
    expectedRevision: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
    chzProductGroupCodes: productGroupCodesSchema.optional(),
  })
  .transform((data, ctx) => {
    const result: {
      name?: string;
      purpose?: LabelTemplatePurpose;
      spec?: StoredLabelTemplateSpec;
      format?: "label_v1" | "pallet_sheet_v2";
      expectedRevision?: number;
      enabled?: boolean;
      chzProductGroupCodes?: number[] | null;
    } = {};
    if (data.format !== undefined) result.format = data.format;
    if (data.expectedRevision !== undefined) result.expectedRevision = data.expectedRevision;
    if (data.name !== undefined) result.name = data.name;
    if (data.purpose !== undefined) result.purpose = data.purpose;
    if (data.spec !== undefined) result.spec = parseSpecOrAddIssues(data.spec, ctx);
    if (data.enabled !== undefined) result.enabled = data.enabled;
    if (data.chzProductGroupCodes !== undefined) {
      result.chzProductGroupCodes = data.chzProductGroupCodes;
    }
    return result;
  });
export type UpdateLabelTemplateDto = z.infer<typeof updateLabelTemplateSchema>;

/** Full response DTO for a label template (GET /:id, POST, PATCH). */
export interface LabelTemplateDto {
  purpose: LabelTemplatePurpose;
  id: string;
  name: string;
  spec: StoredLabelTemplateSpec;
  format?: "label_v1" | "pallet_sheet_v2";
  revision?: number;
  enabled: boolean;
  /** `null` means every category; otherwise ЧЗ product-group codes. */
  chzProductGroupCodes: number[] | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Projected summary DTO for the list endpoint -- avoids shipping full specs to the library screen. */
export interface LegacyLabelTemplateSummaryDto {
  purpose: LabelTemplatePurpose;
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: 203 | 300;
  language: "zpl" | "tspl";
  format?: "label_v1";
  revision?: number;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
  updatedAt: Date;
}
export interface PalletSheetTemplateSummaryDto {
  purpose: "pallet";
  id: string;
  name: string;
  format: "pallet_sheet_v2";
  revision: number;
  page: { size: "A4"; orientation: "portrait" | "landscape"; copies: 1 | 2 };
  dpi: 300;
  enabled: boolean;
  chzProductGroupCodes: number[] | null;
  updatedAt: Date;
}
export type LabelTemplateSummaryDto = LegacyLabelTemplateSummaryDto | PalletSheetTemplateSummaryDto;

/** GET /label-templates response. */
export interface ListLabelTemplatesResponseDto {
  items: LabelTemplateSummaryDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;
const productGroupCodesOpenApiSchema = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  minItems: 1,
  nullable: true,
  description: "ЧЗ product-group codes the template applies to; null means every category.",
} as const;

/**
 * Generated from the domain's own `labelTemplateSpecSchema`, so the full
 * element model (text | field | barcode | line | box discriminated union)
 * stays in lockstep with what `parseLabelTemplate` actually accepts. The
 * schema's one cross-element `superRefine` invariant (unique element ids)
 * is not representable in JSON Schema, hence the description.
 */
const labelTemplateSpecOpenApiSchema: SchemaObject = {
  ...zodApiSchema(labelTemplateSpecSchema),
  description:
    "Printer-agnostic label layout. Every element's `id` must be unique within the template " +
    "(enforced server-side; not expressible in JSON Schema).",
};

export const labelTemplateOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "spec",
    "purpose",
    "enabled",
    "chzProductGroupCodes",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    name: { type: "string", minLength: 1, maxLength: 200 },
    spec: labelTemplateSpecOpenApiSchema,
    format: { type: "string", enum: ["label_v1"] },
    revision: { type: "integer", minimum: 1 },
    purpose: { type: "string", enum: ["box", "product_duplicate", "pallet"] },
    enabled: { type: "boolean" },
    chzProductGroupCodes: productGroupCodesOpenApiSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
};

export const labelTemplateSummaryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "name",
    "widthMm",
    "heightMm",
    "dpi",
    "language",
    "purpose",
    "enabled",
    "chzProductGroupCodes",
    "updatedAt",
  ],
  properties: {
    id: uuidSchema,
    name: { type: "string", minLength: 1, maxLength: 200 },
    format: { type: "string", enum: ["label_v1"] },
    revision: { type: "integer", minimum: 1 },
    widthMm: { type: "number", minimum: 10, maximum: 300 },
    heightMm: { type: "number", minimum: 10, maximum: 300 },
    dpi: {
      type: "integer",
      enum: [203, 300],
      description:
        "Authoring resolution used by the admin preview and code import. The station prints every template at its own printer's resolution; a station without a configured printer resolution prints box labels at this authoring resolution and refuses duplicate printing until one is set.",
    },
    language: { type: "string", enum: ["zpl", "tspl"] },
    purpose: { type: "string", enum: ["box", "product_duplicate", "pallet"] },
    enabled: { type: "boolean" },
    chzProductGroupCodes: productGroupCodesOpenApiSchema,
    updatedAt: dateTimeSchema,
  },
};

export const labelTemplateIsDefaultOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "organizationDefault", "categoryDefaults"],
  properties: {
    code: { type: "string", enum: ["LABEL_TEMPLATE_IS_DEFAULT"] },
    message: { type: "string" },
    organizationDefault: { type: "boolean" },
    categoryDefaults: { type: "array", items: { type: "integer" } },
  },
};

export const listLabelTemplatesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: labelTemplateSummaryOpenApiSchema } },
};

/** The recursive node schema lives in a registered component. Inline JSON Schema
 * definitions would otherwise point outside the enclosing OpenAPI document. */
export class PalletSheetNodeDocument {
  declare value: SheetNode;
}
const nodeReference = "#/components/schemas/PalletSheetNodeDocument/properties/value";
function sheetSchemaForOpenApi(schema: z.ZodType): SchemaObject {
  const generated = zodApiSchema(schema);
  Reflect.deleteProperty(generated, "definitions");
  return JSON.parse(
    JSON.stringify(generated)
      .replaceAll('"$ref":"#/definitions/__schema0"', `"$ref":"${nodeReference}"`)
      .replaceAll('"$ref":"#"', `"$ref":"${nodeReference}"`),
  ) as SchemaObject;
}
ApiProperty({ oneOf: sheetSchemaForOpenApi(sheetNodeSchema).oneOf ?? [], type: Object })(
  PalletSheetNodeDocument.prototype,
  "value",
);
export const palletSheetOpenApiSchema = sheetSchemaForOpenApi(palletSheetSpecSchema);
export const createStoredTemplateBodyOpenApiSchema: SchemaObject = {
  ...zodApiSchema(createLabelTemplateSchema),
  properties: {
    ...zodApiSchema(createLabelTemplateSchema).properties,
    spec: { oneOf: [labelTemplateSpecOpenApiSchema, palletSheetOpenApiSchema] },
  },
};
export const updateStoredTemplateBodyOpenApiSchema: SchemaObject = {
  ...zodApiSchema(updateLabelTemplateSchema),
  properties: {
    ...zodApiSchema(updateLabelTemplateSchema).properties,
    spec: { oneOf: [labelTemplateSpecOpenApiSchema, palletSheetOpenApiSchema] },
  },
};
export const storedLabelTemplateOpenApiSchema: SchemaObject = {
  oneOf: [
    labelTemplateOpenApiSchema,
    {
      ...labelTemplateOpenApiSchema,
      required: [...(labelTemplateOpenApiSchema.required ?? []), "format", "revision"],
      properties: {
        ...labelTemplateOpenApiSchema.properties,
        format: { type: "string", enum: ["pallet_sheet_v2"] },
        revision: { type: "integer", minimum: 1 },
        purpose: { type: "string", enum: ["pallet"] },
        spec: palletSheetOpenApiSchema,
      },
    },
  ],
};
export const storedLabelTemplatesListOpenApiSchema: SchemaObject = {
  ...listLabelTemplatesOpenApiSchema,
  properties: {
    items: {
      type: "array",
      items: {
        oneOf: [
          labelTemplateSummaryOpenApiSchema,
          {
            type: "object",
            additionalProperties: false,
            required: [
              "id",
              "name",
              "purpose",
              "format",
              "revision",
              "page",
              "dpi",
              "enabled",
              "chzProductGroupCodes",
              "updatedAt",
            ],
            properties: {
              id: uuidSchema,
              name: { type: "string" },
              purpose: { type: "string", enum: ["pallet"] },
              format: { type: "string", enum: ["pallet_sheet_v2"] },
              revision: { type: "integer", minimum: 1 },
              page: {
                type: "object",
                required: ["size", "orientation", "copies"],
                properties: {
                  size: { type: "string", enum: ["A4"] },
                  orientation: { type: "string", enum: ["portrait", "landscape"] },
                  copies: { type: "integer", enum: [1, 2] },
                },
              },
              dpi: { type: "integer", enum: [300] },
              enabled: { type: "boolean" },
              chzProductGroupCodes: productGroupCodesOpenApiSchema,
              updatedAt: dateTimeSchema,
            },
          },
        ],
      },
    },
  },
};
export function supportsPalletSheets(header: unknown): boolean {
  return (
    typeof header === "string" &&
    header
      .split(",")
      .map((s) => s.trim())
      .includes("pallet-sheet-v2")
  );
}
