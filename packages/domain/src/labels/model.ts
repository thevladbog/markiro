import { z } from "zod";
import { DomainError } from "../errors.js";
import { formatSsccHri } from "../gs1/sscc.js";
import { formatLabelDate } from "./date.js";

/** Data sources a text/field element on a label can be bound to. */
export const LABEL_FIELDS = [
  "product.name",
  "product.gtin",
  "product.egais",
  "km.code",
  "sscc",
  "shift.no",
  "date",
  "expiry",
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

/**
 * `maxWidthMm` is a hard CONSTRAINT, not just an alignment box: text is
 * broken into at most `maxLines` lines that each fit it, and any remainder is
 * truncated with an ellipsis (see `wrap.ts`). `maxLines` is optional and
 * defaults to 1 — one line, clipped — which is what every template authored
 * before wrapping existed already expects. Without `maxWidthMm` there is no
 * width to wrap against and text is emitted on a single unbounded line.
 */
const wrappableTextShape = {
  fontSizePt: z.number().min(4).max(72),
  bold: z.boolean().optional(),
  align: alignSchema.optional(),
  maxWidthMm: z.number().positive().optional(),
  maxLines: z.number().int().min(1).max(16).optional(),
};

const textElementSchema = z.object({
  kind: z.literal("text"),
  ...elementBaseShape,
  text: z.string(),
  ...wrappableTextShape,
});
export type LabelTextElement = z.infer<typeof textElementSchema>;

const fieldElementSchema = z.object({
  kind: z.literal("field"),
  ...elementBaseShape,
  field: labelFieldSchema,
  ...wrappableTextShape,
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
  /**
   * LINEAR (code128/ean13) X-DIMENSION — the width of one narrow bar, in
   * millimetres, matching the rest of this mm-based model. Ignored by the
   * matrix formats, whose module side is `sizeMm`.
   *
   * OPTIONAL, and absent means "leave it to the printer": both emitters then
   * emit exactly what they emitted before this field existed (ZPL: no `^BY`,
   * so the printer's modal default applies; TSPL: its historical fixed 2-dot
   * narrow bar). That default is precisely the problem this field exists to
   * solve — a modal `^BY` left behind by a previously printed label changes
   * the width of a barcode whose template never mentioned one, so the same
   * spec prints differently on two printers and even on the same printer at
   * different times. Templates that care state the X-dimension explicitly;
   * every stock template in `defaults.ts` does.
   *
   * The emitters convert it to whole dots (`mmToDots`), which is the only
   * unit a printer accepts, so a value that is not a whole number of dots at
   * the spec's `dpi` is rounded to the nearest one.
   */
  moduleWidthMm: z.number().positive().optional(),
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
 *
 * `superRefine` enforces the one CROSS-element invariant `labelElementSchema`
 * itself can't express in isolation: every element's `id` must be unique
 * within the template. Element ids are how the editor (selection, drag,
 * property edits) and the ZPL/TSPL emitters' callers address a specific
 * element — a duplicate id would make "the element with id X" ambiguous,
 * silently breaking whichever consumer picks the "wrong" of the two matches
 * (e.g. `Array.prototype.find` always resolving to the first). The issue is
 * rooted at `["elements"]` (not a specific index) since the defect is a
 * relationship BETWEEN elements, not a single element's own field.
 */
const labelTemplateSpecSchema = z
  .object({
    widthMm: z.number().min(10).max(300),
    heightMm: z.number().min(10).max(300),
    dpi: dpiSchema,
    language: z.enum(["zpl", "tspl"]),
    elements: z.array(labelElementSchema),
  })
  .superRefine((spec, ctx) => {
    const seenIds = new Set<string>();
    for (const element of spec.elements) {
      if (seenIds.has(element.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate element id "${element.id}": every element's id must be unique within a label template`,
          path: ["elements"],
        });
      }
      seenIds.add(element.id);
    }
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

/**
 * Deterministic sample values for every `LabelField`, used by previews and
 * golden tests.
 *
 * The two DATE fields go through `formatLabelDate` rather than carrying a
 * hand-written string: they are what the admin preview draws, and the station
 * runs its real values through the very same function (`box-label.ts`), so
 * routing both through one formatter is what keeps the preview WYSIWYG with
 * the print. Hard-coding `"2026-07-23"` here is exactly how the ISO format
 * shipped to a physical label in the first place.
 */
export function sampleLabelData(): Record<LabelField, string> {
  return {
    "product.name": "Пиво светлое 0,5 л",
    "product.gtin": "04600682000013",
    "product.egais": "0101234567890123456",
    "km.code": "010460068200001321abcDEF1234567",
    sscc: "346006820000000014",
    "shift.no": "214",
    date: formatLabelDate("2026-07-23"),
    expiry: formatLabelDate("2027-01-19"),
    qty: "20",
    operator: "Смирнов А.",
    "counterparty.name": "Завод Партнер",
  };
}

/**
 * Resolves a `field` element's display text. The one field-specific rule
 * lives here: `sscc` renders in GS1 HRI form `(00)…` — the barcode emitters
 * already add the AI to the encoded data, and Chestny ZNAK requires the
 * human-readable form to show it too. Tolerant by design: preview/generation
 * may run with empty or arbitrary data, so a value that isn't 18 digits is
 * returned unchanged rather than throwing.
 */
export function labelFieldDisplayValue(
  field: LabelField,
  data: Record<LabelField, string>,
): string {
  const value = data[field] ?? "";
  return field === "sscc" && /^\d{18}$/.test(value) ? formatSsccHri(value) : value;
}
