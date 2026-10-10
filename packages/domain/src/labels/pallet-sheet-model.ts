import { z } from "zod";
import { DomainError } from "../errors.js";

export const PALLET_SHEET_MAX_NODES = 200;
export const PALLET_SHEET_MAX_DEPTH = 8;
export const PALLET_SHEET_DPI = 300;
export const SSCC_SYMBOL_MODULES = 156;
export const GS1_128_QUIET_MODULES = 10;
export const GS1_128_MAX_WIDTH_MM = 165.1;

export const PALLET_SHEET_FIELDS = [
  "organization.name",
  "product.printName",
  "product.gtin",
  "product.egais",
  "productionDate",
  "expiryDate",
  "boxCount",
  "itemCount",
  "shiftNumber",
] as const;
export type PalletSheetField = (typeof PALLET_SHEET_FIELDS)[number];
const field = z.enum(PALLET_SHEET_FIELDS);
const mm = z.number().min(0).max(300);
const positiveMm = z.number().positive().max(300);
const condition = z.strictObject({ field, op: z.literal("present") });
const margins = z.strictObject({ top: mm, right: mm, bottom: mm, left: mm });
export type SheetMargins = z.infer<typeof margins>;
const base = {
  id: z.string().min(1).max(100),
  when: condition.optional(),
  widthMm: positiveMm.optional(),
  heightMm: positiveMm.optional(),
  grow: z.number().positive().max(100).optional(),
  xMm: mm.optional(),
  yMm: mm.optional(),
};
const textStyle = {
  fontSizePt: z.number().min(4).max(72),
  fontFamily: z.enum(["IBM Plex Sans", "IBM Plex Mono"]).optional(),
  bold: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  maxLines: z.number().int().min(1).max(16).optional(),
  reservedLines: z.number().int().min(1).max(16).optional(),
  overflow: z.literal("error").optional(),
};
const textNode = z.strictObject({
  ...base,
  kind: z.literal("text"),
  text: z.string().max(16_000),
  ...textStyle,
});
const fieldNode = z.strictObject({ ...base, kind: z.literal("field"), field, ...textStyle });
const rowFieldNode = z.strictObject({
  ...base,
  kind: z.literal("field_row"),
  label: z.string().min(1).max(200),
  field,
  ...textStyle,
  labelFontSizePt: z.number().min(4).max(72).optional(),
  gapMm: mm.optional(),
});
const logoNode = z.strictObject({
  ...base,
  kind: z.literal("organization_logo"),
  source: z.literal("organization"),
  fallback: z.literal("markiro"),
  maxHeightMm: z.number().positive().max(50),
});
const lineNode = z.strictObject({
  ...base,
  kind: z.literal("line"),
  thicknessMm: z.number().positive().max(5),
});
const boxNode = z.strictObject({
  ...base,
  kind: z.literal("box"),
  heightMm: positiveMm,
  thicknessMm: z.number().positive().max(5),
  filled: z.boolean().optional(),
});
const spacerNode = z.strictObject({ ...base, kind: z.literal("spacer"), heightMm: positiveMm });
const flowBase = z.strictObject({ ...base, gapMm: mm.optional(), paddingMm: margins.optional() });
const canvasBase = z.strictObject({ ...base, heightMm: positiveMm, paddingMm: margins.optional() });

export type SheetTextNode = z.infer<typeof textNode>;
export type SheetFieldNode = z.infer<typeof fieldNode>;
export type SheetFieldRowNode = z.infer<typeof rowFieldNode>;
export type SheetLogoNode = z.infer<typeof logoNode>;
export type SheetLineNode = z.infer<typeof lineNode>;
export type SheetBoxNode = z.infer<typeof boxNode>;
export type SheetSpacerNode = z.infer<typeof spacerNode>;
export type SheetFlowNode = z.infer<typeof flowBase> & {
  kind: "stack" | "row";
  children: SheetNode[];
};
export type SheetCanvasNode = z.infer<typeof canvasBase> & {
  kind: "canvas";
  children: SheetNode[];
};
export type SheetNode =
  | SheetTextNode
  | SheetFieldNode
  | SheetFieldRowNode
  | SheetLogoNode
  | SheetLineNode
  | SheetBoxNode
  | SheetSpacerNode
  | SheetFlowNode
  | SheetCanvasNode;

export const sheetNodeSchema: z.ZodType<SheetNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    textNode,
    fieldNode,
    rowFieldNode,
    logoNode,
    lineNode,
    boxNode,
    spacerNode,
    z.strictObject({
      ...flowBase.shape,
      kind: z.literal("stack"),
      children: z.array(sheetNodeSchema).min(1).max(PALLET_SHEET_MAX_NODES),
    }),
    z.strictObject({
      ...flowBase.shape,
      kind: z.literal("row"),
      children: z.array(sheetNodeSchema).min(1).max(PALLET_SHEET_MAX_NODES),
    }),
    z.strictObject({
      ...canvasBase.shape,
      kind: z.literal("canvas"),
      children: z.array(sheetNodeSchema).min(1).max(PALLET_SHEET_MAX_NODES),
    }),
  ]),
);

const footerSchema = z.strictObject({
  id: z.string().min(1).max(100),
  kind: z.literal("sscc"),
  source: z.literal("sscc"),
  barHeightMm: z.number().min(31.75).max(100),
  moduleDots: z.number().int().min(6).max(11),
  fallbackModuleDots: z.number().int().min(6).max(11).optional(),
  align: z.enum(["left", "center", "right"]),
});
export type SheetSsccFooter = z.infer<typeof footerSchema>;

export function ssccWidthMm(moduleDots: number): number {
  return ((SSCC_SYMBOL_MODULES + 2 * GS1_128_QUIET_MODULES) * moduleDots * 25.4) / PALLET_SHEET_DPI;
}

export const palletSheetSpecSchema = z
  .strictObject({
    schemaVersion: z.literal(2),
    kind: z.literal("pallet_sheet"),
    dpi: z.literal(PALLET_SHEET_DPI),
    page: z.strictObject({
      size: z.literal("A4"),
      orientation: z.enum(["portrait", "landscape"]),
      copies: z.union([z.literal(1), z.literal(2)]),
      cutLine: z.boolean(),
      marginsMm: margins,
    }),
    body: z.array(sheetNodeSchema).max(PALLET_SHEET_MAX_NODES),
    footer: footerSchema,
  })
  .superRefine((spec, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const pageWidth = spec.page.orientation === "portrait" ? 210 : 297;
    const pageHeight = spec.page.orientation === "portrait" ? 297 : 210;
    const cellWidth = pageWidth / spec.page.copies;
    const m = spec.page.marginsMm;
    const usableWidth = cellWidth - m.left - m.right;
    const usableHeight = pageHeight - m.top - m.bottom;
    if (spec.page.copies === 2 && spec.page.orientation !== "landscape")
      issue(["page", "copies"], "Two identical copies require landscape A4");
    if (spec.page.cutLine && spec.page.copies !== 2)
      issue(["page", "cutLine"], "A cut line requires two identical copies");
    if (usableWidth <= 0 || usableHeight <= 0)
      issue(["page", "marginsMm"], "Page margins leave no space for content");
    const f = spec.footer;
    if (f.fallbackModuleDots !== undefined && f.fallbackModuleDots > f.moduleDots)
      issue(
        ["footer", "fallbackModuleDots"],
        "Fallback module size must not exceed the preferred size",
      );
    const narrowest = f.fallbackModuleDots ?? f.moduleDots;
    if (ssccWidthMm(f.moduleDots) > GS1_128_MAX_WIDTH_MM || ssccWidthMm(narrowest) > usableWidth)
      issue(["footer", "moduleDots"], "SSCC with 10X quiet zones does not fit the label");
    if (f.barHeightMm + 16 > usableHeight)
      issue(["footer", "barHeightMm"], "SSCC bars and interpretation do not fit the label height");
    const ids = new Set<string>([f.id]);
    const visit = (
      nodes: SheetNode[],
      path: (string | number)[],
      canvas: { width: number; height: number } | null,
    ) => {
      nodes.forEach((node, i) => {
        const p = [...path, i];
        if (ids.has(node.id))
          issue([...p, "id"], "Every element id must be unique, including the SSCC footer");
        ids.add(node.id);
        if (
          "reservedLines" in node &&
          node.reservedLines !== undefined &&
          node.reservedLines > (node.maxLines ?? 1)
        )
          issue([...p, "reservedLines"], "Reserved lines must not exceed maxLines");
        if (canvas) {
          if (node.xMm === undefined || node.yMm === undefined || node.widthMm === undefined)
            issue(p, "Canvas children require finite xMm, yMm and widthMm");
          else if (
            node.xMm + node.widthMm > canvas.width ||
            node.yMm >= canvas.height ||
            (node.heightMm !== undefined && node.yMm + node.heightMm > canvas.height)
          )
            issue(p, "Element extends outside its canvas bounds");
        } else if (node.xMm !== undefined || node.yMm !== undefined) {
          issue(p, "Positions are only supported for children of a canvas");
        }
        if ("children" in node) {
          const pad = node.paddingMm;
          const bounds =
            node.kind === "canvas"
              ? {
                  width: (node.widthMm ?? usableWidth) - (pad?.left ?? 0) - (pad?.right ?? 0),
                  height: node.heightMm - (pad?.top ?? 0) - (pad?.bottom ?? 0),
                }
              : null;
          visit(node.children, [...p, "children"], bounds);
        }
      });
    };
    visit(spec.body, ["body"], null);
  });
export type PalletSheetSpecV2 = z.infer<typeof palletSheetSpecSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bound recursive parsing before Zod traverses untrusted node trees. */
function assertTreeLimits(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.body)) return;
  if (value.body.length > PALLET_SHEET_MAX_NODES)
    throw new DomainError("LABEL_SHEET_LIMIT", "Sheet exceeds 200 content nodes");
  const stack = value.body.map((node) => ({ node: node as unknown, depth: 1 }));
  const seen = new Set<object>();
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    if (++count + stack.length > PALLET_SHEET_MAX_NODES)
      throw new DomainError("LABEL_SHEET_LIMIT", "Sheet exceeds 200 content nodes");
    if (current.depth > PALLET_SHEET_MAX_DEPTH)
      throw new DomainError("LABEL_SHEET_LIMIT", "Sheet exceeds maximum depth 8");
    if (!isRecord(current.node)) continue;
    if (seen.has(current.node))
      throw new DomainError("LABEL_SHEET_LIMIT", "Sheet tree contains cyclic or shared nodes");
    seen.add(current.node);
    const children = current.node.children;
    if (Array.isArray(children)) {
      if (count + stack.length + children.length > PALLET_SHEET_MAX_NODES)
        throw new DomainError("LABEL_SHEET_LIMIT", "Sheet exceeds 200 content nodes");
      for (const node of children) stack.push({ node: node as unknown, depth: current.depth + 1 });
    }
  }
}

export function parsePalletSheetSpec(value: unknown): PalletSheetSpecV2 {
  assertTreeLimits(value);
  const result = palletSheetSpecSchema.safeParse(value);
  if (!result.success) {
    const cause = result.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({
            path: [...issue.path, key].join("."),
            message: "Unknown sheet property",
          }))
        : [{ path: issue.path.join("."), message: issue.message }],
    );
    const first = cause[0];
    throw new DomainError(
      "LABEL_SHEET_INVALID",
      first ? `${first.path}: ${first.message}` : "Invalid pallet sheet",
      { cause },
    );
  }
  return result.data;
}
