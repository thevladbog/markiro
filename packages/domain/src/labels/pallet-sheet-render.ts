import { DomainError } from "../errors.js";
import { isValidSscc, formatSsccHri } from "../gs1/sscc.js";
import { addCalendarDays, shelfLifeExpiryDate } from "./shelf-life.js";
import { formatLabelDate } from "./date.js";
import { sampleLabelData, mmToDots } from "./model.js";
import { renderMonoLabel } from "./mono-render.js";
import { encodeMonoRaster, type MonoRaster } from "./mono-raster.js";
import {
  parsePalletSheetSpec,
  ssccWidthMm,
  type PalletSheetSpecV2,
  type SheetNode,
  type PalletSheetField,
  type SheetMargins,
} from "./pallet-sheet-model.js";
import {
  bitmapFromText,
  createSheetPage,
  pasteMonoBitmap,
  rectangleBitmap,
  scaleMonoBitmap,
  validateMonoBitmap,
  type MonoBitmap,
} from "./mono-compose.js";
import type { RasterizeTextFn } from "./raster-types.js";

export interface SheetLogo extends MonoBitmap {
  digest: string;
  source: "organization" | "markiro";
  revision?: string;
}
export interface PalletSheetContext {
  sscc: string;
  productPrintName: string;
  gtin14: string;
  egaisCode: string | null;
  productionDate: string | null;
  shelfLifeDays: number | null;
  boxCount: number;
  itemCount: number;
  shiftNumber: string | null;
  organizationName: string;
  logo: SheetLogo;
}
export interface SheetGeometry {
  widthMm: number;
  heightMm: number;
  printableBoundsMm: { left: number; top: number; right: number; bottom: number };
  guardMm?: number;
}
export interface ResolvedSheetGeometry {
  widthDots: number;
  heightDots: number;
  cellWidthDots: number;
  effectiveMarginsMm: SheetMargins;
  moduleDots: number;
  cellBounds: { left: number; top: number; right: number; bottom: number };
}
function fail(id: string, reason: string): never {
  throw new DomainError("LABEL_SHEET_LAYOUT", `${id}: ${reason}`, {
    cause: [{ path: id, message: reason }],
  });
}
export function nominalSheetGeometry(spec: PalletSheetSpecV2): SheetGeometry {
  const widthMm = spec.page.orientation === "portrait" ? 210 : 297;
  const heightMm = spec.page.orientation === "portrait" ? 297 : 210;
  return {
    widthMm,
    heightMm,
    printableBoundsMm: { left: 0, top: 0, right: widthMm, bottom: heightMm },
    guardMm: 0.5,
  };
}
export function resolvePalletSheetGeometry(
  input: PalletSheetSpecV2,
  geometry: SheetGeometry,
): ResolvedSheetGeometry {
  const spec = parsePalletSheetSpec(input),
    nominal = nominalSheetGeometry(spec),
    b = geometry.printableBoundsMm;
  if (
    !b ||
    geometry.widthMm !== nominal.widthMm ||
    geometry.heightMm !== nominal.heightMm ||
    ![b.left, b.top, b.right, b.bottom, geometry.guardMm ?? 0.5].every(Number.isFinite) ||
    b.left < 0 ||
    b.top < 0 ||
    b.right > geometry.widthMm ||
    b.bottom > geometry.heightMm ||
    b.right <= b.left ||
    b.bottom <= b.top ||
    (geometry.guardMm ?? 0.5) < 0 ||
    (geometry.guardMm ?? 0.5) > 10
  )
    fail("page", "Invalid or substituted printer page geometry");
  const guard = geometry.guardMm ?? 0.5,
    m = spec.page.marginsMm;
  const effectiveMarginsMm = {
    left: Math.max(m.left, b.left + guard),
    top: Math.max(m.top, b.top + guard),
    right: Math.max(m.right, geometry.widthMm - b.right + guard),
    bottom: Math.max(m.bottom, geometry.heightMm - b.bottom + guard),
  };
  const dots = (mm: number) => Math.ceil((mm * 300) / 25.4);
  const widthDots = mmToDots(geometry.widthMm, 300),
    heightDots = mmToDots(geometry.heightMm, 300);
  const cellWidthDots = widthDots / spec.page.copies;
  const cellBounds = {
    left: dots(effectiveMarginsMm.left),
    top: dots(effectiveMarginsMm.top),
    right: cellWidthDots - dots(effectiveMarginsMm.right),
    bottom: heightDots - dots(effectiveMarginsMm.bottom),
  };
  let moduleDots = spec.footer.moduleDots;
  if (176 * moduleDots > cellBounds.right - cellBounds.left)
    moduleDots = spec.footer.fallbackModuleDots ?? moduleDots;
  if (
    !Number.isSafeInteger(cellWidthDots) ||
    cellBounds.right <= cellBounds.left ||
    cellBounds.bottom <= cellBounds.top ||
    176 * moduleDots > cellBounds.right - cellBounds.left
  )
    fail("footer", "SSCC quiet zones do not fit the printer's available area");
  return { widthDots, heightDots, cellWidthDots, cellBounds, moduleDots, effectiveMarginsMm };
}
function contextFields(context: PalletSheetContext): Record<PalletSheetField, string> {
  if (!isValidSscc(context.sscc)) fail("sscc", "Invalid SSCC");
  if (![context.boxCount, context.itemCount].every((n) => Number.isSafeInteger(n) && n >= 0))
    fail("quantity", "Exact quantities are unavailable");
  if (
    !context.organizationName?.trim() ||
    !context.productPrintName?.trim() ||
    !/^\d{14}$/.test(context.gtin14)
  )
    fail("context", "Required organization or product data is unavailable");
  if (context.egaisCode !== null && !/^\d{19}$/.test(context.egaisCode))
    fail("product.egais", "Invalid EGAIS code");
  if (context.productionDate !== null && !addCalendarDays(context.productionDate, 0))
    fail("productionDate", "Invalid production date");
  if (
    context.shelfLifeDays !== null &&
    (!Number.isSafeInteger(context.shelfLifeDays) || context.shelfLifeDays < 1)
  )
    fail("expiryDate", "Invalid shelf life");
  validateMonoBitmap(context.logo);
  return {
    "organization.name": context.organizationName,
    "product.printName": context.productPrintName,
    "product.gtin": context.gtin14,
    "product.egais": context.egaisCode ?? "",
    productionDate: context.productionDate ? formatLabelDate(context.productionDate) : "",
    expiryDate: context.productionDate
      ? formatLabelDate(shelfLifeExpiryDate(context.productionDate, context.shelfLifeDays))
      : "",
    boxCount: String(context.boxCount),
    itemCount: String(context.itemCount),
    shiftNumber: context.shiftNumber ?? "",
  };
}
export interface SheetElementRegion {
  id: string;
  copy: number;
  leftMm: number;
  topMm: number;
  widthMm: number;
  heightMm: number;
}
interface Paint {
  nodeId?: string;
  x: number;
  y: number;
  bitmap: MonoBitmap;
}
interface Block {
  width: number;
  height: number;
  paints: Paint[];
}
function shifted(block: Block, x: number, y: number): Paint[] {
  return block.paints.map((p) => ({ ...p, x: p.x + x, y: p.y + y }));
}
function visible(node: SheetNode, fields: Record<PalletSheetField, string>): boolean {
  return !node.when || fields[node.when.field] !== "";
}

export async function renderPalletSheet(
  input: PalletSheetSpecV2,
  context: PalletSheetContext,
  geometry: SheetGeometry,
  rasterizeText: RasterizeTextFn,
  onMeasured?: (regions: SheetElementRegion[]) => void,
): Promise<MonoRaster> {
  const spec = parsePalletSheetSpec(input),
    resolved = resolvePalletSheetGeometry(spec, geometry),
    fields = contextFields(context);
  const d = (mm: number) => Math.round((mm * 300) / 25.4);
  const paintText = async (
    id: string,
    text: string,
    width: number,
    size: number,
    lines = 1,
    family = "IBM Plex Sans",
    bold = false,
  ): Promise<MonoBitmap> => {
    try {
      const bitmap = bitmapFromText(
        await rasterizeText(text, {
          fontFamily: family,
          fontSizePx: (size * 300) / 72,
          bold,
          maxWidthPx: width,
          maxLines: lines,
          overflow: "error",
        }),
      );
      if (bitmap.width > width || bitmap.height > Math.ceil(((size * 300) / 72) * 1.5) * lines)
        fail(id, "Text raster exceeds its declared bounds");
      return bitmap;
    } catch (error) {
      if (error instanceof DomainError) fail(id, error.message);
      throw error;
    }
  };
  const layoutStack = async (nodes: SheetNode[], width: number, gap: number): Promise<Block> => {
    let height = 0;
    const paints: Paint[] = [];
    let nonempty = 0;
    for (const child of nodes) {
      const block = await layout(child, width);
      if (block.height === 0) continue;
      if (nonempty++) height += gap;
      paints.push(...shifted(block, 0, height));
      height += block.height;
    }
    return { width, height, paints };
  };
  const layout = async (node: SheetNode, availableWidth: number): Promise<Block> => {
    if (!visible(node, fields)) return { width: availableWidth, height: 0, paints: [] };
    const width = node.widthMm === undefined ? availableWidth : d(node.widthMm);
    if (width < 1 || width > availableWidth) fail(node.id, "Element width exceeds its container");
    let block: Block;
    if (node.kind === "text" || node.kind === "field" || node.kind === "field_row") {
      const value = node.kind === "text" ? node.text : fields[node.field];
      if (value === "" && node.kind !== "text") return { width, height: 0, paints: [] };
      const bitmap = await paintText(
        node.id,
        value,
        width,
        node.fontSizePt,
        node.maxLines ?? 1,
        node.fontFamily,
        node.bold,
      );
      const align = (w: number) =>
        node.align === "right"
          ? width - w
          : node.align === "center"
            ? Math.floor((width - w) / 2)
            : 0;
      const reserved = Math.ceil(((node.fontSizePt * 300) / 72) * 1.5) * (node.reservedLines ?? 1);
      const valueHeight = Math.max(bitmap.height, reserved);
      if (node.kind === "field_row") {
        const caption = await paintText(
          node.id,
          node.label,
          width,
          node.labelFontSizePt ?? 8,
          1,
          node.fontFamily,
        );
        const gap = d(node.gapMm ?? 1);
        block = {
          width,
          height: caption.height + gap + valueHeight,
          paints: [
            { x: align(caption.width), y: 0, bitmap: caption },
            { x: align(bitmap.width), y: caption.height + gap, bitmap },
          ],
        };
      } else
        block = { width, height: valueHeight, paints: [{ x: align(bitmap.width), y: 0, bitmap }] };
    } else if (node.kind === "organization_logo") {
      const maxHeight = d(node.maxHeightMm),
        naturalWidth = Math.max(
          1,
          Math.round((maxHeight * context.logo.width) / context.logo.height),
        );
      const logoWidth = Math.min(width, naturalWidth),
        logoHeight = Math.max(
          1,
          Math.round((logoWidth * context.logo.height) / context.logo.width),
        );
      const bitmap = scaleMonoBitmap(context.logo, logoWidth, logoHeight);
      block = { width, height: logoHeight, paints: [{ x: 0, y: 0, bitmap }] };
    } else if (node.kind === "spacer") block = { width, height: d(node.heightMm), paints: [] };
    else if (node.kind === "line" || node.kind === "box") {
      const thickness = Math.max(1, d(node.thicknessMm)),
        height = node.kind === "line" ? thickness : d(node.heightMm);
      block = {
        width,
        height,
        paints: [
          {
            x: 0,
            y: 0,
            bitmap: rectangleBitmap(width, height, thickness, node.kind === "line" || node.filled),
          },
        ],
      };
    } else {
      const pad = node.paddingMm,
        l = d(pad?.left ?? 0),
        r = d(pad?.right ?? 0),
        t = d(pad?.top ?? 0),
        b = d(pad?.bottom ?? 0);
      const inner = width - l - r;
      if (inner < 1) fail(node.id, "Padding leaves no content width");
      const children = node.children.filter((child) => visible(child, fields));
      let content: Block;
      if (node.kind === "stack") content = await layoutStack(children, inner, d(node.gapMm ?? 0));
      else if (node.kind === "canvas") {
        const paints: Paint[] = [],
          height = d(node.heightMm) - t - b;
        if (height < 1) fail(node.id, "Padding leaves no canvas height");
        for (const child of children) {
          if (child.xMm === undefined || child.yMm === undefined || child.widthMm === undefined)
            fail(child.id, "Missing canvas position");
          const x = d(child.xMm),
            y = d(child.yMm),
            childBlock = await layout(child, d(child.widthMm));
          if (x + childBlock.width > inner || y + childBlock.height > height)
            fail(child.id, "Measured content exceeds canvas bounds");
          paints.push(...shifted(childBlock, x, y));
        }
        content = { width: inner, height, paints };
      } else {
        const gap = d(node.gapMm ?? 0),
          budget = inner - Math.max(0, children.length - 1) * gap;
        const fixed = children.map((child) =>
          child.widthMm !== undefined
            ? d(child.widthMm)
            : child.kind === "organization_logo"
              ? Math.min(
                  inner,
                  Math.round((d(child.maxHeightMm) * context.logo.width) / context.logo.height),
                )
              : 0,
        );
        const free = budget - fixed.reduce((sum, w) => sum + w, 0);
        const flex = children.filter((_child, i) => !fixed[i]);
        if (
          children.some((child) => child.kind === "organization_logo") &&
          flex.length > 0 &&
          free < d(30) * flex.length
        ) {
          content = await layoutStack(children, inner, gap);
        } else {
          if (free < 0 || budget < 1) fail(node.id, "Row children exceed the available width");
          const shares = flex.reduce((sum, child) => sum + (child.grow ?? 1), 0);
          let x = 0,
            height = 0;
          const paints: Paint[] = [];
          for (const [i, child] of children.entries()) {
            const childWidth = fixed[i] || Math.floor((free * (child.grow ?? 1)) / shares);
            if (childWidth < 1) fail(child.id, "Row leaves no width for the element");
            const measured = await layout(child, childWidth);
            paints.push(...shifted(measured, x, 0));
            height = Math.max(height, measured.height);
            x += childWidth + gap;
          }
          content = { width: inner, height, paints };
        }
      }
      block = { width, height: content.height + t + b, paints: shifted(content, l, t) };
    }
    if (node.heightMm !== undefined) {
      const height = d(node.heightMm);
      if (block.height > height) fail(node.id, "Measured content exceeds declared height");
      block.height = height;
    }
    block.paints = block.paints.map((paint) => ({ ...paint, nodeId: paint.nodeId ?? node.id }));
    return block;
  };
  const bounds = resolved.cellBounds,
    usableWidth = bounds.right - bounds.left;
  const footerWidth = 176 * resolved.moduleDots;
  const barcode = await renderMonoLabel(
    {
      widthMm: ssccWidthMm(resolved.moduleDots),
      heightMm: spec.footer.barHeightMm,
      dpi: 300,
      language: "zpl",
      elements: [
        {
          id: "sscc",
          kind: "barcode",
          format: "code128",
          data: "sscc",
          xMm: (10 * resolved.moduleDots * 25.4) / 300,
          yMm: 0,
          sizeMm: spec.footer.barHeightMm,
          moduleWidthMm: (resolved.moduleDots * 25.4) / 300,
        },
      ],
    },
    { ...sampleLabelData(), sscc: context.sscc },
    rasterizeText,
  );
  const bars: MonoBitmap = {
    width: barcode.widthDots,
    height: barcode.heightDots,
    stride: barcode.stride,
    pixels: barcode.pixels,
  };
  const caption = await paintText("footer", "SSCC · ИДЕНТИФИКАТОР ПАЛЕТЫ", footerWidth, 8);
  const hri = await paintText(
    "footer",
    formatSsccHri(context.sscc),
    footerWidth,
    14,
    1,
    "IBM Plex Mono",
  );
  const gap = d(2),
    footerHeight = caption.height + gap + bars.height + gap + hri.height;
  const footerTop = bounds.bottom - footerHeight;
  const body = await layoutStack(spec.body, usableWidth, d(2));
  if (body.height > footerTop - bounds.top - gap)
    fail(spec.body.at(-1)?.id ?? "body", "Body content overlaps the reserved SSCC footer");
  const footerX =
    bounds.left +
    (spec.footer.align === "left"
      ? 0
      : spec.footer.align === "right"
        ? usableWidth - footerWidth
        : Math.floor((usableWidth - footerWidth) / 2));
  const page = createSheetPage(geometry.widthMm, geometry.heightMm);
  const regions: SheetElementRegion[] = [];
  for (let copy = 0; copy < spec.page.copies; copy++) {
    const offset = copy * resolved.cellWidthDots;
    const measured = new Map<
      string,
      { left: number; top: number; right: number; bottom: number }
    >();
    for (const p of body.paints) {
      pasteMonoBitmap(page, p.bitmap, offset + bounds.left + p.x, bounds.top + p.y);
      if (p.nodeId) {
        const old = measured.get(p.nodeId);
        measured.set(p.nodeId, {
          left: Math.min(old?.left ?? p.x, p.x),
          top: Math.min(old?.top ?? p.y, p.y),
          right: Math.max(old?.right ?? 0, p.x + p.bitmap.width),
          bottom: Math.max(old?.bottom ?? 0, p.y + p.bitmap.height),
        });
      }
    }
    for (const [id, region] of measured)
      regions.push({
        id,
        copy,
        leftMm: ((offset + bounds.left + region.left) * 25.4) / 300,
        topMm: ((bounds.top + region.top) * 25.4) / 300,
        widthMm: ((region.right - region.left) * 25.4) / 300,
        heightMm: ((region.bottom - region.top) * 25.4) / 300,
      });
    regions.push({
      id: spec.footer.id,
      copy,
      leftMm: ((offset + footerX) * 25.4) / 300,
      topMm: (footerTop * 25.4) / 300,
      widthMm: (footerWidth * 25.4) / 300,
      heightMm: (footerHeight * 25.4) / 300,
    });
    pasteMonoBitmap(
      page,
      caption,
      offset + footerX + Math.floor((footerWidth - caption.width) / 2),
      footerTop,
    );
    pasteMonoBitmap(page, bars, offset + footerX, footerTop + caption.height + gap);
    pasteMonoBitmap(
      page,
      hri,
      offset + footerX + Math.floor((footerWidth - hri.width) / 2),
      footerTop + caption.height + gap + bars.height + gap,
    );
  }
  if (spec.page.cutLine) {
    for (let y = bounds.top; y + d(2) < footerTop - gap; y += d(5))
      pasteMonoBitmap(page, rectangleBitmap(1, d(2), 1, true), resolved.cellWidthDots, y);
  }
  encodeMonoRaster(page);
  onMeasured?.(regions);
  return page;
}
