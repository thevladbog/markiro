import { describe, expect, it } from "vitest";
import {
  assertKmTemplate,
  buildKmLabelTemplates,
  KM_CODE_ONLY_LABEL_NAMES,
  KM_LABEL_TEMPLATE_NAME,
  labelTemplateSpecSchema,
  type LabelTemplatePurpose,
} from "../src/index.js";

describe("KM label template", () => {
  it("ships one stock 58×40 template with a km.code Data Matrix and a crypto-free serial line", () => {
    const [template] = buildKmLabelTemplates();
    expect(template?.name).toBe(KM_LABEL_TEMPLATE_NAME);
    const spec = labelTemplateSpecSchema.parse(template?.spec);
    expect([spec.widthMm, spec.heightMm]).toEqual([58, 40]);
    const dm = spec.elements.find((e) => e.kind === "barcode");
    expect(dm).toMatchObject({ format: "datamatrix", data: "km.code" });
    expect(
      spec.elements.some(
        (e) => e.kind === "field" && e.field === "km.code" && e.textFormat === "km_without_crypto",
      ),
    ).toBe(true);
    expect(() => assertKmTemplate(spec)).not.toThrow();
  });

  it.each([
    { name: KM_CODE_ONLY_LABEL_NAMES[0], sideMm: 15, sizeMm: 11, marginMm: 2 },
    { name: KM_CODE_ONLY_LABEL_NAMES[1], sideMm: 20, sizeMm: 15, marginMm: 2.5 },
  ])(
    "ships $name carrying the code alone, centred with blank stock on every side",
    ({ name, sideMm, sizeMm, marginMm }) => {
      const template = buildKmLabelTemplates().find((t) => t.name === name);
      expect(template, `${name} must be a stock template`).toBeDefined();
      const spec = labelTemplateSpecSchema.parse(template?.spec);
      expect([spec.widthMm, spec.heightMm]).toEqual([sideMm, sideMm]);

      // Nothing but the symbol: no text, no field, no rule. A person never
      // reads stock this narrow, and anything else would crowd the code.
      expect(spec.elements).toHaveLength(1);
      const dm = spec.elements[0];
      expect(dm).toMatchObject({
        kind: "barcode",
        format: "datamatrix",
        data: "km.code",
        xMm: marginMm,
        yMm: marginMm,
        sizeMm,
      });

      // Square, centred, and the blank margin is equal on all four sides --
      // asserted from the geometry rather than from the numbers above, so a
      // later edit that moves the symbol off centre fails here.
      if (dm?.kind !== "barcode") throw new Error("expected a barcode element");
      expect(dm.xMm).toBe(spec.widthMm - dm.xMm - dm.sizeMm);
      expect(dm.yMm).toBe(spec.heightMm - dm.yMm - dm.sizeMm);
      expect(dm.xMm).toBeGreaterThan(0);

      expect(() => assertKmTemplate(spec)).not.toThrow();
    },
  );

  it("ships the three stock templates in a stable order, informative one first", () => {
    expect(buildKmLabelTemplates().map((t) => t.name)).toEqual([
      KM_LABEL_TEMPLATE_NAME,
      ...KM_CODE_ONLY_LABEL_NAMES,
    ]);
  });

  it("refuses a template without a km.code Data Matrix with its own error code", () => {
    const [template] = buildKmLabelTemplates();
    const spec = labelTemplateSpecSchema.parse(template?.spec);
    const broken = { ...spec, elements: spec.elements.filter((e) => e.kind !== "barcode") };
    expect(() => assertKmTemplate(broken)).toThrowError(
      expect.objectContaining({ code: "KM_LABEL_TEMPLATE_INVALID" }),
    );
  });

  it("widens the purpose union", () => {
    const purpose: LabelTemplatePurpose = "product_km";
    expect(purpose).toBe("product_km");
  });
});
