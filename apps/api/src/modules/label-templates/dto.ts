import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";
import {
  DomainError,
  labelTemplateSpecSchema,
  parseLabelTemplate,
  type LabelTemplateSpec,
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
function parseSpecOrAddIssues(spec: unknown, ctx: z.RefinementCtx): LabelTemplateSpec {
  try {
    return parseLabelTemplate(spec);
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

/** POST /label-templates schema. `spec` is validated by @markiro/domain's parseLabelTemplate. */
export const createLabelTemplateSchema = z
  .object({
    name: z.string().min(1).max(200),
    spec: z.unknown(),
  })
  .transform((data, ctx) => ({
    name: data.name,
    spec: parseSpecOrAddIssues(data.spec, ctx),
  }));
export type CreateLabelTemplateDto = z.infer<typeof createLabelTemplateSchema>;

/** PATCH /label-templates/:id schema -- partial update, preserves untouched fields. */
export const updateLabelTemplateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    spec: z.unknown().optional(),
  })
  .transform((data, ctx) => {
    const result: { name?: string; spec?: LabelTemplateSpec } = {};
    if (data.name !== undefined) result.name = data.name;
    if (data.spec !== undefined) result.spec = parseSpecOrAddIssues(data.spec, ctx);
    return result;
  });
export type UpdateLabelTemplateDto = z.infer<typeof updateLabelTemplateSchema>;

/** Full response DTO for a label template (GET /:id, POST, PATCH). */
export interface LabelTemplateDto {
  id: string;
  name: string;
  spec: LabelTemplateSpec;
  createdAt: Date;
  updatedAt: Date;
}

/** Projected summary DTO for the list endpoint -- avoids shipping full specs to the library screen. */
export interface LabelTemplateSummaryDto {
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: 203 | 300;
  language: "zpl" | "tspl";
  updatedAt: Date;
}

/** GET /label-templates response. */
export interface ListLabelTemplatesResponseDto {
  items: LabelTemplateSummaryDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

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
  required: ["id", "name", "spec", "createdAt", "updatedAt"],
  properties: {
    id: uuidSchema,
    name: { type: "string", minLength: 1, maxLength: 200 },
    spec: labelTemplateSpecOpenApiSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
};

export const labelTemplateSummaryOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "widthMm", "heightMm", "dpi", "language", "updatedAt"],
  properties: {
    id: uuidSchema,
    name: { type: "string", minLength: 1, maxLength: 200 },
    widthMm: { type: "number", minimum: 10, maximum: 300 },
    heightMm: { type: "number", minimum: 10, maximum: 300 },
    dpi: { type: "integer", enum: [203, 300] },
    language: { type: "string", enum: ["zpl", "tspl"] },
    updatedAt: dateTimeSchema,
  },
};

export const listLabelTemplatesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: labelTemplateSummaryOpenApiSchema } },
};
