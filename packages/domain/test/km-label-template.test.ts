import { describe, expect, it } from "vitest";
import {
  assertKmTemplate,
  buildKmLabelTemplates,
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
