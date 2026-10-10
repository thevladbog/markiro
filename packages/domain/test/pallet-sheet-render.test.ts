import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";
import { decodeFixtureSscc } from "./helpers/decode-sscc-bars.js";
import { makeSheetSpec } from "./support/pallet-sheet.js";

const logo = {
  width: 40,
  height: 10,
  stride: 5,
  pixels: new Uint8Array(50).fill(255),
  digest: "demo",
  source: "markiro" as const,
};
const context: domain.PalletSheetContext = {
  sscc: "146000000000001231",
  productPrintName: "Вода питьевая Северный источник",
  gtin14: "04600000000015",
  egaisCode: null,
  productionDate: "2026-10-10",
  shelfLifeDays: 365,
  boxCount: 48,
  itemCount: 576,
  shiftNumber: "OCT26-014/S",
  organizationName: "Название организации",
  logo,
};
function textRecorder() {
  const printed: string[] = [];
  const rasterize: domain.RasterizeTextFn = async (text, opts) => {
    printed.push(text);
    const measure = (value: string) => value.length * opts.fontSizePx * 0.5;
    const lines = domain.wrapTextToWidthStrict(
      text,
      measure,
      opts.maxWidthPx ?? 3508,
      opts.maxLines ?? 1,
    );
    const width = Math.max(1, Math.ceil(Math.max(...lines.map(measure))));
    const height = Math.ceil(opts.fontSizePx * 1.5) * lines.length;
    const stride = Math.ceil(width / 8);
    const pixels = new Uint8Array(stride * height);
    pixels[0] = 128;
    return {
      width,
      height,
      bytesPerRow: stride,
      totalBytes: pixels.length,
      hex: Array.from(pixels, (v) => v.toString(16).padStart(2, "0")).join(""),
    };
  };
  return { printed, rasterize };
}

describe("complete A4 sheet rendering", () => {
  it.each([
    ["pallet-a4-portrait", 2480, 3508],
    ["pallet-a4-landscape", 3508, 2480],
    ["pallet-a4-two-a5", 3508, 2480],
  ])("renders %s as one bounded 300 dpi page with a decodable SSCC", async (key, w, h) => {
    expect(domain.renderPalletSheet).toBeTypeOf("function");
    const preset = domain.buildPalletSheetPresets().find((p) => p.key === key);
    if (!preset) throw new Error("Missing preset");
    const { rasterize } = textRecorder();
    const page = await domain.renderPalletSheet(
      preset.spec,
      context,
      domain.nominalSheetGeometry(preset.spec),
      rasterize,
    );
    expect([page.widthDots, page.heightDots, page.dpi]).toEqual([w, h, 300]);
    expect(domain.encodeMonoRaster(page).length).toBeLessThan(2 * 1024 * 1024);
    const cell = page.widthDots / preset.spec.page.copies;
    expect(decodeFixtureSscc(page, 0, cell)).toBe("00146000000000001231");
    if (preset.spec.page.copies === 2)
      expect(decodeFixtureSscc(page, cell, cell)).toBe("00146000000000001231");
  });
  it("duplicates one content cell byte-for-byte into both halves", async () => {
    const preset = domain.buildPalletSheetPresets().find((p) => p.key === "pallet-a4-two-a5");
    if (!preset) throw new Error("Missing preset");
    const spec = { ...preset.spec, page: { ...preset.spec.page, cutLine: false } };
    const page = await domain.renderPalletSheet(
      spec,
      context,
      domain.nominalSheetGeometry(spec),
      textRecorder().rasterize,
    );
    const bits = (offset: number) =>
      Array.from({ length: page.heightDots }, (_, y) => {
        let row = "";
        for (let x = 0; x < page.widthDots / 2; x++)
          row +=
            ((page.pixels[y * page.stride + ((x + offset) >> 3)] ?? 0) >>
              (7 - ((x + offset) % 8))) &
            1;
        return row;
      });
    expect(bits(0)).toEqual(bits(page.widthDots / 2));
  });
  it("omits the complete date and expiry rows when production date is absent", async () => {
    const spec = makeSheetSpec();
    spec.body.push({
      id: "expiry",
      kind: "field_row",
      field: "expiryDate",
      label: "ГОДЕН ДО",
      fontSizePt: 14,
      when: { field: "expiryDate", op: "present" },
    });
    const { printed, rasterize } = textRecorder();
    await domain.renderPalletSheet(
      spec,
      { ...context, productionDate: null },
      domain.nominalSheetGeometry(spec),
      rasterize,
    );
    expect(printed).not.toContain("ПРОИЗВЕДЕНО");
    expect(printed).not.toContain("ГОДЕН ДО");
    expect(printed).not.toContain("10.10.2026");
    expect(printed).not.toContain("09.10.2027");
  });
  it.each([
    ["2026-10-10", 1, "10.10.2026"],
    ["2024-02-28", 2, "29.02.2024"],
  ])("uses inclusive expiry from %s", async (productionDate, shelfLifeDays, expiry) => {
    const spec = makeSheetSpec();
    spec.body.push({ id: "expiry", kind: "field", field: "expiryDate", fontSizePt: 14 });
    const { printed, rasterize } = textRecorder();
    await domain.renderPalletSheet(
      spec,
      { ...context, productionDate, shelfLifeDays },
      domain.nominalSheetGeometry(spec),
      rasterize,
    );
    expect(printed).toContain(expiry);
  });
  it("renders complete EGAIS leading zeroes when present and omits the empty row", async () => {
    const spec = makeSheetSpec();
    spec.body.push({
      id: "egais",
      kind: "field_row",
      label: "КОД ЕГАИС",
      field: "product.egais",
      fontSizePt: 12,
      when: { field: "product.egais", op: "present" },
    });
    const a = textRecorder();
    await domain.renderPalletSheet(
      spec,
      { ...context, egaisCode: "0123456789012345678" },
      domain.nominalSheetGeometry(spec),
      a.rasterize,
    );
    expect(a.printed).toContain("0123456789012345678");
    const b = textRecorder();
    await domain.renderPalletSheet(spec, context, domain.nominalSheetGeometry(spec), b.rasterize);
    expect(b.printed).not.toContain("КОД ЕГАИС");
  });
  it("selects the 8-dot preset before rendering when printer margins constrain A5", async () => {
    const preset = domain.buildPalletSheetPresets().find((p) => p.key === "pallet-a4-two-a5");
    if (!preset) throw new Error("Missing preset");
    const geometry = domain.nominalSheetGeometry(preset.spec);
    geometry.printableBoundsMm.left = 8;
    const effective = domain.resolvePalletSheetGeometry(preset.spec, geometry);
    expect(effective.moduleDots).toBe(8);
    const page = await domain.renderPalletSheet(
      preset.spec,
      context,
      geometry,
      textRecorder().rasterize,
    );
    expect(decodeFixtureSscc(page, 0, page.widthDots / 2)).toBe("00146000000000001231");
  });
  it.each([1, 4, 10])(
    "keeps a %i:1 logo within the cell without distortion or overflow",
    async (ratio) => {
      const spec = makeSheetSpec();
      const width = ratio * 10,
        stride = Math.ceil(width / 8);
      const pixels = new Uint8Array(stride * 10);
      pixels[0] = 128;
      const page = await domain.renderPalletSheet(
        spec,
        { ...context, logo: { ...logo, width, stride, pixels } },
        domain.nominalSheetGeometry(spec),
        textRecorder().rasterize,
      );
      expect(page.requiredBounds.right).toBeLessThanOrEqual(page.widthDots);
    },
  );
  it("rejects unavailable quantities and invalid SSCC before creating output", async () => {
    const spec = makeSheetSpec();
    const geometry = domain.nominalSheetGeometry(spec);
    await expect(
      domain.renderPalletSheet(
        spec,
        { ...context, itemCount: NaN },
        geometry,
        textRecorder().rasterize,
      ),
    ).rejects.toThrow(domain.DomainError);
    await expect(
      domain.renderPalletSheet(
        spec,
        { ...context, sscc: "146000000000001230" },
        geometry,
        textRecorder().rasterize,
      ),
    ).rejects.toThrow(domain.DomainError);
  });
  it("reports the offending node instead of truncating a name or clipping canvas content", async () => {
    const spec = makeSheetSpec();
    spec.body = [
      { id: "long-name", kind: "field", field: "product.printName", fontSizePt: 72, maxLines: 1 },
    ];
    await expect(
      domain.renderPalletSheet(
        spec,
        { ...context, productPrintName: "Очень длинное название ".repeat(20) },
        domain.nominalSheetGeometry(spec),
        textRecorder().rasterize,
      ),
    ).rejects.toThrow("long-name");
  });
  it.each(
    domain
      .buildPalletSheetPresets()
      .flatMap((preset) => [1, 4, 10].map((ratio) => ({ preset, ratio }))),
  )("fits full optional data and a $ratio:1 logo in $preset.key", async ({ preset, ratio }) => {
    const width = ratio * 10,
      stride = Math.ceil(width / 8);
    const pixels = new Uint8Array(stride * 10);
    pixels[0] = 128;
    const name = Array.from(
      {
        length:
          preset.spec.page.copies === 1 && preset.spec.page.orientation === "landscape" ? 4 : 5,
      },
      () => "Название",
    ).join("\n");
    const page = await domain.renderPalletSheet(
      preset.spec,
      {
        ...context,
        productPrintName: name,
        egaisCode: "0123456789012345678",
        logo: { ...logo, width, stride, pixels },
      },
      domain.nominalSheetGeometry(preset.spec),
      textRecorder().rasterize,
    );
    expect(page.requiredBounds.bottom).toBeLessThanOrEqual(page.heightDots);
  });
  it("rejects measured canvas overflow even when declared coordinates fit", async () => {
    const spec = makeSheetSpec();
    spec.body = [
      {
        id: "canvas",
        kind: "canvas",
        heightMm: 10,
        children: [
          {
            id: "too-tall",
            kind: "text",
            text: "Текст",
            fontSizePt: 30,
            xMm: 0,
            yMm: 0,
            widthMm: 100,
          },
        ],
      },
    ];
    await expect(
      domain.renderPalletSheet(
        spec,
        context,
        domain.nominalSheetGeometry(spec),
        textRecorder().rasterize,
      ),
    ).rejects.toThrow("too-tall");
  });
});
it("reports measured element bounds from the actual renderer without changing print bytes", async () => {
  const spec = makeSheetSpec();
  spec.body = [
    {
      id: "free",
      kind: "canvas",
      heightMm: 30,
      children: [
        { id: "placed", kind: "text", text: "Text", fontSizePt: 8, widthMm: 30, xMm: 4, yMm: 3 },
      ],
    },
  ];
  const { rasterize } = textRecorder();
  const regions: Array<{
    id: string;
    copy: number;
    leftMm: number;
    topMm: number;
    widthMm: number;
    heightMm: number;
  }> = [];
  const traced = await domain.renderPalletSheet(
    spec,
    context,
    domain.nominalSheetGeometry(spec),
    rasterize,
    (items) => regions.push(...items),
  );
  const plain = await domain.renderPalletSheet(
    spec,
    context,
    domain.nominalSheetGeometry(spec),
    rasterize,
  );
  expect(domain.encodeMonoRaster(traced)).toEqual(domain.encodeMonoRaster(plain));
  expect(regions.find((item) => item.id === "placed")).toMatchObject({
    copy: 0,
    leftMm: expect.any(Number),
    topMm: expect.any(Number),
  });
  expect(regions.find((item) => item.id === "placed")?.leftMm).toBe(
    ((Math.ceil((spec.page.marginsMm.left * 300) / 25.4) + Math.round((4 * 300) / 25.4)) * 25.4) /
      300,
  );
  expect(regions.find((item) => item.id === spec.footer.id)).toBeDefined();
});
it.each(["pallet-a4-portrait", "pallet-a4-two-a5"])(
  "%s reserves real driver margins while retaining SSCC quiet zones in artifact bounds",
  async (key) => {
    const preset = domain.buildPalletSheetPresets().find((item) => item.key === key);
    if (!preset) throw new Error("Missing preset");
    const nominal = domain.nominalSheetGeometry(preset.spec),
      geometry = {
        ...nominal,
        printableBoundsMm: {
          left: 4,
          top: 4,
          right: nominal.widthMm - 4,
          bottom: nominal.heightMm - 4,
        },
      };
    const resolved = domain.resolvePalletSheetGeometry(preset.spec, geometry);
    const { rasterize } = textRecorder();
    const page = await domain.renderPalletSheet(preset.spec, context, geometry, rasterize);
    expect(page.requiredBounds).toEqual({
      left: resolved.cellBounds.left,
      top: resolved.cellBounds.top,
      right: (preset.spec.page.copies - 1) * resolved.cellWidthDots + resolved.cellBounds.right,
      bottom: resolved.cellBounds.bottom,
    });
    expect(page.requiredBounds.left).toBeGreaterThan((4 * 300) / 25.4);
    expect(page.requiredBounds.right).toBeLessThan(((nominal.widthMm - 4) * 300) / 25.4);
    expect(() => domain.encodeMonoRaster(page)).not.toThrow();
  },
);
