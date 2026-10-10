import { buildDefaultLabelTemplates, type DefaultLabelTemplate } from "../labels/defaults.js";

/** An explicit layout for records whose historical date fields were not retained. */
export function buildWarehouseCodeOnlyLabelTemplate(): DefaultLabelTemplate {
  return {
    name: "Код Data Matrix 30×30",
    spec: {
      language: "zpl",
      widthMm: 30,
      heightMm: 30,
      dpi: 203,
      elements: [
        {
          id: "km",
          kind: "barcode",
          format: "datamatrix",
          data: "km.code",
          xMm: 4,
          yMm: 4,
          sizeMm: 22,
        },
      ],
    },
  };
}

export function buildWarehouseCodeOnlyBoxTemplate(): DefaultLabelTemplate {
  const stock = buildDefaultLabelTemplates()[0];
  if (!stock) throw new Error("Stock box template missing");
  return {
    name: "SSCC короба 58×40",
    spec: {
      ...stock.spec,
      elements: stock.spec.elements
        .filter(
          (e) =>
            (e.kind === "barcode" && e.data === "sscc") ||
            (e.kind === "field" && e.field === "sscc"),
        )
        .map((e) => (e.kind === "barcode" ? { ...e, yMm: 5, sizeMm: 24 } : { ...e, yMm: 32 })),
    },
  };
}
