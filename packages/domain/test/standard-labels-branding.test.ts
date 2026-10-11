import { describe, expect, it } from "vitest";
import {
  buildDefaultLabelTemplates,
  buildPalletLabelTemplates,
  parseLabelTemplate,
  generateZpl,
  generateTspl,
  renderMonoLabel,
  sampleLabelData,
  renderLabelLogo,
  mmToDots,
  createLabelRenderPlan,
  type MonoBitmap,
  withPrinterDpi,
  wrapTextToWidth,
  type RasterizeTextFn,
} from "../src/index.js";

const logoSpec = () =>
  parseLabelTemplate({
    widthMm: 75,
    heightMm: 120,
    dpi: 203,
    language: "zpl",
    elements: [
      {
        kind: "organization_logo",
        id: "logo",
        xMm: 4,
        yMm: 3,
        widthMm: 30,
        heightMm: 7,
        source: "organization",
        fallback: "markiro",
      },
    ],
  });

describe("approved standard label family", () => {
  it("reserves four name lines and a dynamic logo in every non-58 box", () => {
    const templates = buildDefaultLabelTemplates();
    expect(templates).toHaveLength(16);
    for (const { spec } of templates.filter((t) => t.spec.widthMm !== 58)) {
      expect(spec.elements.some((e) => e.kind === ("organization_logo" as string))).toBe(true);
      expect(
        spec.elements.find(
          (e) => e.kind === "field" && ["product.name", "product.printName"].includes(e.field),
        ),
      ).toMatchObject({ maxLines: 4 });
      expect(spec.elements.find((e) => e.kind === "barcode" && e.data === "sscc")).toMatchObject({
        sizeMm: expect.any(Number),
      });
      expect(
        spec.elements.filter((e) => e.kind === "field" && e.field === "shift.no"),
      ).toHaveLength(0);
    }
    for (const { spec } of templates.filter((t) => t.spec.widthMm === 58))
      expect(spec.elements.some((e) => e.kind === ("organization_logo" as string))).toBe(false);
  });
  it("adds Palet 75×120, keeps the existing 58×40 identity and removes shift only from larger pallets", () => {
    const templates = buildPalletLabelTemplates();
    expect(templates.map((t) => t.name)).toEqual([
      "Палет 100×150",
      "Паллета 58×40",
      "Палет 75×120",
    ]);
    for (const { spec } of templates.filter((t) => t.spec.widthMm !== 58)) {
      expect(spec.elements.find((e) => e.kind === "text" && e.id === "cap-title")).toMatchObject({
        text: "ПАЛЕТ",
      });
      expect(
        spec.elements.filter((e) => e.kind === "field" && e.field === "shift.no"),
      ).toHaveLength(0);
      expect(
        spec.elements.find((e) => e.kind === "field" && e.field === "qty.boxes"),
      ).toMatchObject({ textFormat: "quantity_number" });
    }
  });
  it("retains the organization-logo element through validation", () => {
    expect(logoSpec().elements).toHaveLength(1);
  });
  it("rejects ambiguous SSCC formatting and an inverted automatic font range", () => {
    const base = logoSpec();
    expect(() =>
      parseLabelTemplate({
        ...base,
        elements: [
          {
            kind: "field",
            id: "bad",
            xMm: 0,
            yMm: 0,
            field: "product.name",
            textFormat: "sscc_spaced",
            fontSizePt: 13,
          },
        ],
      }),
    ).toThrow(/sscc/);
    expect(() =>
      parseLabelTemplate({
        ...base,
        elements: [
          {
            kind: "field",
            id: "bad",
            xMm: 0,
            yMm: 0,
            field: "qty",
            fontSizePt: 13,
            minFontSizePt: 20,
          },
        ],
      }),
    ).toThrow(/minFontSizePt/);
  });
  it("fails explicitly rather than silently dropping a missing logo", async () => {
    await expect(generateZpl(logoSpec(), sampleLabelData())).rejects.toThrow(/logo/i);
    await expect(generateTspl(logoSpec(), sampleLabelData())).rejects.toThrow(/logo/i);
  });
});

describe("logo pixels on every print path", () => {
  const logo: MonoBitmap = {
    width: 8,
    height: 4,
    stride: 1,
    pixels: new Uint8Array([0x80, 0x40, 0x20, 0x10]),
  };
  it.each([203, 300] as const)(
    "embeds the same contained raster in ZPL, TSPL and Windows at %i dpi",
    async (dpi) => {
      const spec = { ...logoSpec(), dpi };
      const e = spec.elements[0];
      if (e?.kind !== "organization_logo") throw new Error("logo element missing");
      const fitted = renderLabelLogo(e, dpi, logo);
      const rasterizeText = async () => {
        throw new Error("image must not call text rasterizer");
      };
      const plan = await createLabelRenderPlan(spec, sampleLabelData(), {
        dpi,
        language: "zpl",
        rasterizeText,
        logo,
      });
      expect(plan.elements[0]).toMatchObject({
        kind: "raster",
        xDots: fitted.xDots,
        yDots: fitted.yDots,
        raster: fitted.raster,
      });
      expect(fitted.raster.width / fitted.raster.height).toBeCloseTo(2, 1);
      expect(fitted.raster.width).toBeLessThanOrEqual(mmToDots(30, dpi));
      expect(fitted.raster.height).toBeLessThanOrEqual(mmToDots(7, dpi));
      const zpl = await generateZpl(spec, sampleLabelData(), { logo });
      expect(zpl).toContain(
        `^FO${fitted.xDots},${fitted.yDots}^GFA,${fitted.raster.totalBytes},${fitted.raster.totalBytes},${fitted.raster.bytesPerRow},${fitted.raster.hex}^FS`,
      );
      const tspl = await generateTspl(spec, sampleLabelData(), { logo });
      const prefix = `BITMAP ${fitted.xDots},${fitted.yDots},${fitted.raster.bytesPerRow},${fitted.raster.height},0,`;
      const offset = tspl.indexOf(prefix) + prefix.length;
      expect(tspl).toContain(prefix);
      for (let i = 0; i < fitted.raster.totalBytes; i++)
        expect(tspl.charCodeAt(offset + i)).toBe(
          parseInt(fitted.raster.hex.slice(i * 2, i * 2 + 2), 16) ^ 0xff,
        );
      const mono = await renderMonoLabel(spec, sampleLabelData(), rasterizeText, { logo });
      for (let y = 0; y < fitted.raster.height; y++)
        for (let x = 0; x < fitted.raster.width; x++) {
          const source =
            parseInt(
              fitted.raster.hex.slice(
                (y * fitted.raster.bytesPerRow + (x >> 3)) * 2,
                (y * fitted.raster.bytesPerRow + (x >> 3)) * 2 + 2,
              ),
              16,
            ) &
            (0x80 >> (x % 8));
          const px = x + fitted.xDots,
            py = y + fitted.yDots;
          expect(Boolean(mono.pixels[py * mono.stride + (px >> 3)]! & (0x80 >> (px % 8)))).toBe(
            Boolean(source),
          );
        }
    },
  );
});

describe("complete approved label output at printer resolution", () => {
  const logo: MonoBitmap = {
    width: 8,
    height: 4,
    stride: 1,
    pixels: new Uint8Array([0x80, 0x40, 0x20, 0x10]),
  };
  const text: RasterizeTextFn = async (value, opts) => {
    let size = opts.fontSizePx;
    const width = opts.maxWidthPx ?? 10000;
    const em = opts.fontFamily === "monospace" ? 0.6 : 0.55;
    while (
      opts.minFontSizePx !== undefined &&
      value.length * size * em > width &&
      size > opts.minFontSizePx
    )
      size--;
    const lines = wrapTextToWidth(value, (v) => v.length * size * em, width, opts.maxLines ?? 1);
    const w = Math.max(
      1,
      Math.min(width, Math.ceil(Math.max(...lines.map((v) => v.length * size * em)))),
    );
    const h = Math.ceil(size * (opts.lineHeight ?? 1.5)) * lines.length;
    const stride = Math.ceil(w / 8);
    return {
      width: w,
      height: h,
      bytesPerRow: stride,
      totalBytes: stride * h,
      hex: "00".repeat(stride * h),
    };
  };
  it.each([203, 300] as const)(
    "renders all fourteen templates, four name lines and large counts within the paper at %i dpi",
    async (dpi) => {
      const templates = [...buildDefaultLabelTemplates(), ...buildPalletLabelTemplates()].filter(
        (t) => t.spec.widthMm !== 58,
      );
      expect(templates).toHaveLength(14);
      const fields = {
        ...sampleLabelData(),
        "product.name": "Сидр полусухой\nгазированный\n«ДИКИЙ КРЕСТ»\n0,45 л",
        "product.printName": "Сидр полусухой\nгазированный\n«ДИКИЙ КРЕСТ»\n0,45 л",
        qty: "10000",
        "qty.boxes": "999999",
      };
      for (const { name, spec: original } of templates) {
        const spec = withPrinterDpi(original, dpi);
        const plan = await createLabelRenderPlan(spec, fields, {
          dpi,
          language: "zpl",
          rasterizeText: text,
          logo,
        });
        const headline = plan.elements.find((e) => e.id === "val-name");
        expect(headline, name).toMatchObject({ kind: "raster" });
        const raster = await renderMonoLabel(spec, fields, text, { logo });
        expect(raster.requiredBounds.right, name).toBeLessThanOrEqual(raster.widthDots);
        expect(raster.requiredBounds.bottom, name).toBeLessThanOrEqual(raster.heightDots);
        const bc = spec.elements.find((e) => e.kind === "barcode");
        if (bc?.kind !== "barcode") throw new Error("barcode missing");
        expect(bc.sizeMm, name).toBeGreaterThanOrEqual(31.75);
        const x = (mmToDots(bc.moduleWidthMm!, dpi) * 25.4) / dpi;
        if (spec.widthMm === 100) expect(x, name).toBeGreaterThanOrEqual(0.495);
        else expect(spec.gs1Constraint, name).toBe("sscc_x_below_distribution_minimum");
        await expect(generateZpl(spec, fields, { rasterizeText: text, logo })).resolves.toContain(
          "^GFA",
        );
        await expect(generateTspl(spec, fields, { rasterizeText: text, logo })).resolves.toContain(
          "BITMAP",
        );
      }
    },
  );
});
