import type { LabelElement, LabelField, LabelTemplateSpec } from "./model.js";

/** Approved pen.dev family, 2026-10-10. Physical geometry is millimetres. */
export function buildStandardLabelSpec(
  widthMm: 75 | 100,
  heightMm: 100 | 120 | 150,
  pallet: boolean,
  dated = true,
  nameField: "product.name" | "product.printName" = "product.name",
): LabelTemplateSpec {
  const narrow = widthMm === 75,
    tall = heightMm === 150,
    w = widthMm - 8;
  const elements: LabelElement[] = [];
  const text = (
    id: string,
    value: string,
    x: number,
    y: number,
    width: number,
    font = 13,
    bold = false,
  ) => {
    elements.push({
      kind: "text",
      id,
      text: value,
      xMm: x,
      yMm: y,
      maxWidthMm: width,
      fontSizePt: font,
      bold,
      lineHeight: 1,
    });
  };
  const field = (
    id: string,
    source: LabelField,
    x: number,
    y: number,
    width: number,
    font = 13,
    bold = false,
    align: "left" | "center" | "right" = "left",
    number = false,
  ) => {
    elements.push({
      kind: "field",
      id,
      field: source,
      xMm: x,
      yMm: y,
      maxWidthMm: width,
      fontSizePt: font,
      bold,
      align,
      lineHeight: 1,
      ...(source === "qty" || source === "qty.boxes" ? { minFontSizePt: 13 } : {}),
      ...(number ? { textFormat: "quantity_number" as const } : {}),
      ...(["date", "expiry", "product.egais", "product.gtin", "sscc"].includes(source)
        ? { fontFamily: "monospace" as const }
        : {}),
    });
  };
  const line = (id: string, y: number) =>
    elements.push({
      kind: "line",
      id,
      xMm: 4,
      yMm: y,
      x2Mm: widthMm - 4,
      y2Mm: y,
      thicknessMm: 0.2,
    });
  const row = (id: string, caption: string, source: LabelField, y: number) => {
    const left = narrow ? (pallet ? 24 : 26) : 32;
    text(`cap-${id}`, caption, 4, y, left);
    field(
      `val-${id}`,
      source,
      narrow ? (pallet ? 29 : 31) : 38,
      y,
      narrow ? (pallet ? 42 : 40) : 58,
      13,
      false,
      "right",
    );
  };
  elements.push({
    kind: "organization_logo",
    id: "organization-logo",
    source: "organization",
    fallback: "markiro",
    xMm: 4,
    yMm: pallet && tall ? 4 : 3,
    widthMm: narrow ? 30 : tall ? 38 : 32,
    heightMm: narrow ? 6.857143 : tall ? 8.685714 : 7.314286,
  });
  text(
    "cap-title",
    pallet ? "ПАЛЕТА" : "КОРОБКА",
    narrow ? (pallet ? 39 : 35) : 60,
    pallet && tall ? 6 : 4,
    narrow ? (pallet ? 32 : 36) : 36,
    pallet && tall ? 14 : 13,
    true,
  );
  const title = elements.at(-1);
  if (title?.kind === "text") title.align = "right";
  elements.push({
    kind: "field",
    id: "val-name",
    field: nameField,
    xMm: 4,
    yMm: narrow ? 14 : tall ? 17 : 11,
    maxWidthMm: w,
    maxLines: 4,
    fontSizePt: tall ? 20 : 13,
    bold: true,
    lineHeight: narrow ? 1.13 : tall ? 1.1 : 1,
  });
  if (pallet) {
    line("sep1", narrow ? 36 : 52);
    field(
      "val-boxes",
      "qty.boxes",
      4,
      narrow ? 38 : 56,
      narrow ? 31.5 : 44,
      narrow ? 22 : 30,
      true,
      "left",
      true,
    );
    field(
      "val-units",
      "qty",
      narrow ? 39.5 : 52,
      narrow ? 38 : 56,
      narrow ? 31.5 : 44,
      narrow ? 22 : 30,
      true,
      "left",
      true,
    );
    text("cap-boxes", "КОРОБОВ", 4, narrow ? 48 : 69, narrow ? 31.5 : 44);
    text("cap-units", "ЕДИНИЦ", narrow ? 39.5 : 52, narrow ? 48 : 69, narrow ? 31.5 : 44);
    line("sep2", narrow ? 55 : 77);
    row("date", "ПРОИЗВ.", "date", narrow ? 58.5 : 82);
    row("expiry", "ГОДЕН ДО", "expiry", narrow ? 65.5 : 89.5);
    row("gtin", "GTIN", "product.gtin", narrow ? 72.5 : 97);
  } else if (tall) {
    line("sep1", 52);
    field("val-qty", "qty", 4, 56, w, 30, true, "left", true);
    text("cap-qty", "ЕДИНИЦ В УПАКОВКЕ", 4, 69, w);
    line("sep2", 77);
    if (dated) {
      row("date", "ПРОИЗВ.", "date", 82);
      row("expiry", "ГОДЕН ДО", "expiry", 89.5);
    }
    row("egais", "ЕГАИС", "product.egais", dated ? 97 : 82);
  } else {
    line("sep1", narrow ? 36 : 30.5);
    text("cap-qty", "В УПАКОВКЕ", 4, narrow ? 39 : 32, narrow ? 38 : 57);
    field(
      "val-qty",
      "qty",
      narrow ? 44 : 64,
      narrow ? 38.5 : 31.5,
      narrow ? 27 : 32,
      narrow ? 17 : 15,
      true,
      "right",
    );
    if (narrow) {
      const quantity = elements.at(-1);
      if (quantity?.kind === "field") quantity.minFontSizePt = 13;
    }
    line("sep2", narrow ? 46 : 37.8);
    if (dated) {
      row("date", "ПРОИЗВ.", "date", narrow ? 50 : 39.2);
      row("expiry", "ГОДЕН ДО", "expiry", narrow ? 58 : 44.7);
    }
    if (narrow) {
      text("cap-egais", "ЕГАИС", 4, dated ? 66 : 52, w);
      field("val-egais", "product.egais", 4, dated ? 72.5 : 59.5, w);
    } else row("egais", "ЕГАИС", "product.egais", dated ? 50.2 : 39.5);
  }
  const moduleWidthMm = ((narrow ? 3 : 4) * 25.4) / 203;
  const barY = pallet
    ? narrow
      ? 80
      : 108
    : narrow
      ? dated
        ? 80
        : 69
      : tall
        ? dated
          ? 108
          : 92
        : dated
          ? 57
          : 46;
  const barHeight = pallet || dated ? 32 : tall ? 48 : 43;
  elements.push({
    kind: "barcode",
    id: "bc-sscc",
    data: "sscc",
    format: "code128",
    xMm: (widthMm - 156 * moduleWidthMm) / 2,
    yMm: barY,
    sizeMm: barHeight,
    moduleWidthMm,
  });
  field(
    "val-sscc",
    "sscc",
    4,
    narrow ? 114 : tall ? 142 : 92,
    w,
    narrow ? 13 : 14,
    false,
    "center",
  );
  {
    const hri = elements.at(-1);
    if (hri?.kind === "field") hri.textFormat = narrow ? "sscc_spaced" : "sscc_with_title";
  }
  return {
    widthMm,
    heightMm,
    dpi: 203,
    language: "zpl",
    elements,
    ...(narrow ? { gs1Constraint: "sscc_x_below_distribution_minimum" as const } : {}),
  };
}
