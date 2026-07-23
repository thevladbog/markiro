import { z } from "zod";
import { DomainError } from "../errors.js";

/** Data sources a text/field element on a label can be bound to. */
const LABEL_FIELDS = [
  "product.name",
  "product.gtin",
  "km.code",
  "sscc",
  "shift.no",
  "date",
  "qty",
  "operator",
  "counterparty.name",
] as const;

export type LabelField = (typeof LABEL_FIELDS)[number];

const labelFieldSchema = z.enum(LABEL_FIELDS);

const alignSchema = z.enum(["left", "center", "right"]);

/** Shared placement fields every element carries. */
const elementBaseShape = {
  id: z.string().min(1),
  xMm: z.number(),
  yMm: z.number(),
};

const textElementSchema = z.object({
  kind: z.literal("text"),
  ...elementBaseShape,
  text: z.string(),
  fontSizePt: z.number().min(4).max(72),
  bold: z.boolean().optional(),
  align: alignSchema.optional(),
  maxWidthMm: z.number().positive().optional(),
});
export type LabelTextElement = z.infer<typeof textElementSchema>;

const fieldElementSchema = z.object({
  kind: z.literal("field"),
  ...elementBaseShape,
  field: labelFieldSchema,
  fontSizePt: z.number().min(4).max(72),
  bold: z.boolean().optional(),
  align: alignSchema.optional(),
  maxWidthMm: z.number().positive().optional(),
});
export type LabelFieldElement = z.infer<typeof fieldElementSchema>;

const barcodeFormatSchema = z.enum(["datamatrix", "code128", "ean13", "qr"]);

const barcodeElementSchema = z.object({
  kind: z.literal("barcode"),
  ...elementBaseShape,
  format: barcodeFormatSchema,
  // For code128/ean13, sizeMm is the barcode height (width is derived from the
  // encoded data). For matrix codes (datamatrix/qr) it is the module square side.
  data: z.union([labelFieldSchema, z.object({ literal: z.string() })]),
  sizeMm: z.number().positive(),
});
export type LabelBarcodeElement = z.infer<typeof barcodeElementSchema>;

const lineElementSchema = z.object({
  kind: z.literal("line"),
  ...elementBaseShape,
  x2Mm: z.number(),
  y2Mm: z.number(),
  thicknessMm: z.number().positive(),
});
export type LabelLineElement = z.infer<typeof lineElementSchema>;

const boxElementSchema = z.object({
  kind: z.literal("box"),
  ...elementBaseShape,
  widthMm: z.number().positive(),
  heightMm: z.number().positive(),
  thicknessMm: z.number().positive(),
});
export type LabelBoxElement = z.infer<typeof boxElementSchema>;

const labelElementSchema = z.discriminatedUnion("kind", [
  textElementSchema,
  fieldElementSchema,
  barcodeElementSchema,
  lineElementSchema,
  boxElementSchema,
]);
export type LabelElement = z.infer<typeof labelElementSchema>;

const dpiSchema = z.union([z.literal(203), z.literal(300)]);

/**
 * A printer-agnostic label layout: physical size, print resolution, target
 * command language, and the positioned elements. Elements MAY fall outside
 * `[0, widthMm] x [0, heightMm]` — the schema does not enforce label bounds;
 * that is an editor-time concern, not a model invariant.
 */
const labelTemplateSpecSchema = z.object({
  widthMm: z.number().min(10).max(300),
  heightMm: z.number().min(10).max(300),
  dpi: dpiSchema,
  language: z.enum(["zpl", "tspl"]),
  elements: z.array(labelElementSchema),
});
export type LabelTemplateSpec = z.infer<typeof labelTemplateSpecSchema>;

/** Parses and validates an unknown value as a `LabelTemplateSpec`. */
export function parseLabelTemplate(json: unknown): LabelTemplateSpec {
  const result = labelTemplateSpecSchema.safeParse(json);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const pathStr = firstIssue?.path.join(".") ?? "";
    const message = pathStr
      ? `${pathStr}: ${firstIssue!.message}`
      : (firstIssue?.message ?? "invalid label template");

    const cause = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));

    throw new DomainError("LABEL_INVALID", message, { cause });
  }
  return result.data;
}

/** Converts millimetres to printer dots at the given resolution: round(mm * dpi / 25.4). */
export function mmToDots(mm: number, dpi: number): number {
  return Math.round((mm * dpi) / 25.4);
}

/** Converts points (1pt = 1/72") to printer dots at the given resolution: round(pt / 72 * dpi). */
export function ptToDots(pt: number, dpi: number): number {
  return Math.round((pt / 72) * dpi);
}

/** Deterministic sample values for every `LabelField`, used by previews and golden tests. */
export function sampleLabelData(): Record<LabelField, string> {
  return {
    "product.name": "Пиво светлое 0,5 л",
    "product.gtin": "04600682000013",
    "km.code": "010460068200001321abcDEF1234567",
    sscc: "346006820000000014",
    "shift.no": "214",
    date: "2026-07-23",
    qty: "20",
    operator: "Смирнов А.",
    "counterparty.name": "Завод Партнер",
  };
}
