import { render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  buildWarehouseCodeOnlyBoxTemplate,
  warehouseBoxTemplate,
  productLabelValueDigest,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { LabelPreview } from "../src/ui/warehouse-reprint/LabelPreview.js";
import { rasterizeText } from "../src/lib/rasterizer.js";
vi.mock("../src/lib/rasterizer.js", () => ({ rasterizeText: vi.fn() }));
const bitmap = { width: 9, height: 1, hex: "80ff", bytesPerRow: 2, totalBytes: 2 };
beforeEach(() => vi.mocked(rasterizeText).mockReset().mockResolvedValue(bitmap));
function template(spec: LabelTemplateSpec) {
  const { digest, ...snapshot } = { ...warehouseBoxTemplate(), spec };
  void digest;
  return { ...snapshot, digest: productLabelValueDigest(snapshot) };
}
it("centers the standard SSCC caption in the label's content box", () => {
  const view = render(
    <LabelPreview template={template(buildWarehouseCodeOnlyBoxTemplate().spec)} />,
  );
  const text = view.container.querySelector("text");
  expect(text?.getAttribute("text-anchor")).toBe("middle");
  expect(text?.getAttribute("x")).toBe("29");
});
it("wraps and ellipsizes native text without stretching or overflowing the width", () => {
  const spec: LabelTemplateSpec = {
    language: "tspl",
    dpi: 203,
    widthMm: 58,
    heightMm: 40,
    elements: [
      {
        id: "title",
        kind: "text",
        text: "PACK BOX CODE LONG TITLE",
        xMm: 2,
        yMm: 4,
        fontSizePt: 10,
        maxWidthMm: 20,
        maxLines: 2,
        align: "right",
      },
    ],
  };
  const view = render(<LabelPreview template={template(spec)} />);
  const lines = [...view.container.querySelectorAll("tspan")];
  expect(lines.map((line) => line.textContent)).toEqual(["PACK BOX", "CODE LONG…"]);
  expect(lines.map((line) => line.getAttribute("x"))).toEqual(["22", "22"]);
  expect(view.container.querySelector("text")?.getAttribute("text-anchor")).toBe("end");
  expect(Number(lines[1]?.getAttribute("y"))).toBeCloseTo(9.2916667);
});
it.each([203, 300] as const)("uses the print raster and exact alignment at %s DPI", async (dpi) => {
  const spec: LabelTemplateSpec = {
    language: "tspl",
    dpi: 203,
    widthMm: 58,
    heightMm: 40,
    elements: [
      {
        id: "title",
        kind: "text",
        text: "Длинное название товара",
        xMm: 2,
        yMm: 4,
        fontSizePt: 10,
        maxWidthMm: 20,
        maxLines: 2,
        align: "center",
      },
    ],
  };
  const view = render(<LabelPreview template={template(spec)} dpi={dpi} />);
  await waitFor(() =>
    expect(rasterizeText).toHaveBeenCalledWith("Длинное название товара", {
      fontFamily: "sans-serif",
      fontSizePx: dpi === 203 ? 28 : 42,
      bold: false,
      maxWidthPx: dpi === 203 ? 160 : 236,
      maxLines: 2,
    }),
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-raster-element="title"]')).toBeTruthy(),
  );
  const pixels = view.container.querySelector('[data-raster-element="title"]');
  expect(pixels?.querySelector("path")?.getAttribute("d")).toBe("M0 0h1v1h-1zM8 0h1v1h-1z");
  expect(pixels?.getAttribute("data-x-mm")).toBe(
    dpi === 203 ? String((92 * 25.4) / 203) : String((138 * 25.4) / 300),
  );
});
it("discards a late raster when a different template is selected", async () => {
  let finish: (value: typeof bitmap) => void = () => {};
  vi.mocked(rasterizeText).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const spec: LabelTemplateSpec = {
    language: "tspl",
    dpi: 203,
    widthMm: 58,
    heightMm: 40,
    elements: [
      {
        id: "old",
        kind: "text",
        text: "Старый текст",
        xMm: 2,
        yMm: 4,
        fontSizePt: 10,
        maxWidthMm: 20,
        maxLines: 2,
      },
    ],
  };
  const view = render(<LabelPreview template={template(spec)} />);
  await waitFor(() => expect(rasterizeText).toHaveBeenCalledTimes(1));
  view.rerender(
    <LabelPreview
      template={template({
        ...spec,
        elements: [
          {
            id: "new",
            kind: "text",
            text: "Новый текст",
            xMm: 2,
            yMm: 4,
            fontSizePt: 10,
            maxWidthMm: 20,
            maxLines: 2,
          },
        ],
      })}
    />,
  );
  await waitFor(() =>
    expect(view.container.querySelector('[data-raster-element="new"]')).toBeTruthy(),
  );
  finish(bitmap);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(view.container.querySelector('[data-raster-element="old"]')).toBeNull();
});
