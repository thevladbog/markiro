import { describe, expect, it } from "vitest";
import {
  labelFieldDisplayValue,
  mmToDots,
  parseLabelTemplate,
  ptToDots,
  QTY_UNIT_SUFFIX,
  sampleLabelData,
  type LabelField,
  type LabelTemplateSpec,
} from "../src/labels/model.js";

const validSpec: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [
    { kind: "text", id: "t1", xMm: 2, yMm: 2, text: "Hello", fontSizePt: 12 },
    {
      kind: "text",
      id: "t2",
      xMm: 2,
      yMm: 8,
      text: "Bold centered",
      fontSizePt: 10,
      bold: true,
      align: "center",
      maxWidthMm: 40,
    },
    { kind: "field", id: "f1", xMm: 2, yMm: 14, field: "product.name", fontSizePt: 10 },
    {
      kind: "field",
      id: "f2",
      xMm: 2,
      yMm: 20,
      field: "sscc",
      fontSizePt: 8,
      bold: false,
      align: "right",
    },
    {
      kind: "barcode",
      id: "b1",
      xMm: 2,
      yMm: 24,
      format: "datamatrix",
      data: "km.code",
      sizeMm: 0.5,
    },
    {
      kind: "barcode",
      id: "b2",
      xMm: 20,
      yMm: 24,
      format: "code128",
      data: { literal: "12345" },
      sizeMm: 10,
    },
    { kind: "line", id: "l1", xMm: 0, yMm: 30, x2Mm: 58, y2Mm: 30, thicknessMm: 0.3 },
    { kind: "box", id: "bx1", xMm: 0, yMm: 0, widthMm: 58, heightMm: 40, thicknessMm: 0.2 },
  ],
};

describe("parseLabelTemplate", () => {
  it("accepts a full valid spec", () => {
    expect(parseLabelTemplate(validSpec)).toEqual(validSpec);
  });

  it("accepts an element positioned outside the label bounds (editor concern, not model)", () => {
    const spec: LabelTemplateSpec = {
      ...validSpec,
      elements: [{ kind: "text", id: "t1", xMm: 999, yMm: -50, text: "off-label", fontSizePt: 12 }],
    };
    expect(parseLabelTemplate(spec)).toEqual(spec);
  });

  it("rejects an out-of-range dpi and includes path in message", () => {
    const spec = { ...validSpec, dpi: 150 };
    try {
      parseLabelTemplate(spec);
      expect.fail("should throw");
    } catch (err) {
      const error = err as Error & { code: string; name: string };
      expect(error.code).toBe("LABEL_INVALID");
      expect(error.name).toBe("DomainError");
      expect(error.message).toContain("dpi");
    }
  });

  it("rejects an out-of-range width", () => {
    const spec = { ...validSpec, widthMm: 5 };
    expect(() => parseLabelTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("rejects an out-of-range height", () => {
    const spec = { ...validSpec, heightMm: 301 };
    expect(() => parseLabelTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("rejects an unknown language", () => {
    const spec = { ...validSpec, language: "epl" };
    expect(() => parseLabelTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("rejects an out-of-range fontSizePt", () => {
    const spec: LabelTemplateSpec = {
      ...validSpec,
      elements: [{ kind: "text", id: "t1", xMm: 0, yMm: 0, text: "x", fontSizePt: 100 }],
    };
    expect(() => parseLabelTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("rejects an unknown element kind", () => {
    const spec = {
      ...validSpec,
      elements: [{ kind: "ellipse", id: "e1", xMm: 0, yMm: 0 }],
    };
    expect(() => parseLabelTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("rejects an unknown field value", () => {
    const spec: LabelTemplateSpec = {
      ...validSpec,
      elements: [
        {
          kind: "field",
          id: "f1",
          xMm: 0,
          yMm: 0,
          field: "product.unknown" as never,
          fontSizePt: 10,
        },
      ],
    };
    expect(() => parseLabelTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("rejects non-object input", () => {
    expect(() => parseLabelTemplate("not a spec")).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("rejects a spec with two elements sharing the same id", () => {
    const spec: LabelTemplateSpec = {
      ...validSpec,
      elements: [
        { kind: "text", id: "dup", xMm: 0, yMm: 0, text: "First", fontSizePt: 12 },
        { kind: "text", id: "dup", xMm: 10, yMm: 10, text: "Second", fontSizePt: 12 },
      ],
    };
    try {
      parseLabelTemplate(spec);
      expect.fail("should throw");
    } catch (err) {
      const error = err as Error & { code: string; name: string; cause?: unknown };
      expect(error.code).toBe("LABEL_INVALID");
      expect(error.name).toBe("DomainError");
      expect(error.message).toContain("elements");
      const causes = error.cause as Array<{ path: string; message: string }>;
      expect(causes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "elements", message: expect.stringContaining("dup") }),
        ]),
      );
    }
  });

  it("accepts a spec whose elements all have distinct ids (three-plus elements, no false positive)", () => {
    const spec: LabelTemplateSpec = {
      ...validSpec,
      elements: [
        { kind: "text", id: "a", xMm: 0, yMm: 0, text: "A", fontSizePt: 12 },
        { kind: "text", id: "b", xMm: 5, yMm: 5, text: "B", fontSizePt: 12 },
        { kind: "text", id: "c", xMm: 10, yMm: 10, text: "C", fontSizePt: 12 },
      ],
    };
    expect(parseLabelTemplate(spec)).toEqual(spec);
  });

  it("rejects a negative thicknessMm on a line", () => {
    const spec: LabelTemplateSpec = {
      ...validSpec,
      elements: [{ kind: "line", id: "l1", xMm: 0, yMm: 0, x2Mm: 10, y2Mm: 0, thicknessMm: -1 }],
    };
    expect(() => parseLabelTemplate(spec)).toThrowError(
      expect.objectContaining({ code: "LABEL_INVALID" }),
    );
  });

  it("attaches all validation issues on error.cause", () => {
    const spec = { ...validSpec, dpi: 150, widthMm: 5, heightMm: 500 };
    try {
      parseLabelTemplate(spec);
      expect.fail("should throw");
    } catch (err) {
      const error = err as Error & { code: string; cause?: unknown };
      expect(error.code).toBe("LABEL_INVALID");
      expect(error.cause).toBeDefined();
      expect(Array.isArray(error.cause)).toBe(true);
      const causes = error.cause as Array<{ path: string; message: string }>;
      expect(causes.length).toBeGreaterThanOrEqual(2);
      causes.forEach((cause) => {
        expect(cause).toHaveProperty("path");
        expect(cause).toHaveProperty("message");
        expect(typeof cause.path).toBe("string");
        expect(typeof cause.message).toBe("string");
      });
    }
  });

  it("includes path and message in first error when path is empty", () => {
    try {
      parseLabelTemplate("not an object");
      expect.fail("should throw");
    } catch (err) {
      const error = err as Error & { code: string; cause?: unknown };
      expect(error.code).toBe("LABEL_INVALID");
      expect(error.message).toBeTruthy();
      expect(error.cause).toBeDefined();
      expect(Array.isArray(error.cause)).toBe(true);
    }
  });
});

describe("mmToDots", () => {
  // dots = round(mm * dpi / 25.4). 58 * 203 / 25.4 = 463.543... -> rounds to 464,
  // NOT 463 as the task brief's worked example claims; see report for the discrepancy.
  it("converts 58mm @ 203dpi", () => {
    expect(mmToDots(58, 203)).toBe(464);
  });
  it("converts 100mm @ 300dpi", () => {
    expect(mmToDots(100, 300)).toBe(Math.round((100 * 300) / 25.4));
    expect(mmToDots(100, 300)).toBe(1181);
  });
  it("converts 0mm to 0 dots", () => {
    expect(mmToDots(0, 203)).toBe(0);
  });
});

describe("ptToDots", () => {
  // dots = round(pt / 72 * dpi). 12 / 72 * 203 = 33.833... -> rounds to 34.
  it("converts 12pt @ 203dpi", () => {
    expect(ptToDots(12, 203)).toBe(34);
  });
  it("converts 72pt @ 300dpi (exactly one inch)", () => {
    expect(ptToDots(72, 300)).toBe(300);
  });
  it("converts 0pt to 0 dots", () => {
    expect(ptToDots(0, 203)).toBe(0);
  });
});

describe("sampleLabelData", () => {
  it("returns deterministic sample values for every LabelField, cyrillic included", () => {
    const data = sampleLabelData();
    expect(data).toEqual({
      "product.name": "Пиво светлое 0,5 л",
      "product.printName": "Пиво светлое",
      "product.gtin": "04600682000013",
      "product.egais": "0101234567890123456",
      "km.code": "010460068200001321abcDEF1234567",
      sscc: "346006820000000014",
      "shift.no": "214",
      date: "23.07.2026",
      expiry: "19.01.2027",
      qty: "20",
      operator: "Смирнов А.",
      "counterparty.name": "Завод Партнер",
    });
  });
});

describe("labelFieldDisplayValue", () => {
  function withQty(qty: string): Record<LabelField, string> {
    return { ...sampleLabelData(), qty };
  }

  it("renders an 18-digit SSCC in GS1 HRI form", () => {
    expect(labelFieldDisplayValue("sscc", sampleLabelData())).toBe("(00)346006820000000014");
  });

  it("passes a non-18-digit SSCC through untouched", () => {
    expect(labelFieldDisplayValue("sscc", { ...sampleLabelData(), sscc: "" })).toBe("");
    expect(labelFieldDisplayValue("sscc", { ...sampleLabelData(), sscc: "123" })).toBe("123");
  });

  /**
   * QUANTITY UNIT. The first physical print read a bare `5` where the
   * customer-approved mock-up says «5 шт.». The unit lives in this one
   * display-formatting layer — the emitters AND `bounds.ts` (hence the admin
   * preview and every containment check) all resolve field text through it,
   * so the longer string is accounted for everywhere without a second rule.
   */
  it("appends the «шт.» unit to a plain numeric quantity", () => {
    expect(QTY_UNIT_SUFFIX).toBe("шт.");
    expect(labelFieldDisplayValue("qty", withQty("5"))).toBe("5 шт.");
    expect(labelFieldDisplayValue("qty", withQty("24"))).toBe("24 шт.");
    expect(labelFieldDisplayValue("qty", withQty("0"))).toBe("0 шт.");
    expect(labelFieldDisplayValue("qty", withQty("1000"))).toBe("1000 шт.");
    // Surrounding whitespace is not a different quantity.
    expect(labelFieldDisplayValue("qty", withQty("  7  "))).toBe("7 шт.");
  });

  it("never doubles the unit on a value that already carries it", () => {
    expect(labelFieldDisplayValue("qty", withQty("5 шт."))).toBe("5 шт.");
    expect(labelFieldDisplayValue("qty", withQty("5 шт"))).toBe("5 шт");
  });

  it("passes an empty or non-numeric quantity through untouched", () => {
    for (const raw of ["", "   ", "—", "n/a", "12 кг", "~5", "5.5", "5,5", "1e3", "-3", "+3"]) {
      expect(labelFieldDisplayValue("qty", withQty(raw)), `qty=${JSON.stringify(raw)}`).toBe(raw);
    }
  });

  it("leaves every other field alone", () => {
    const data = sampleLabelData();
    for (const field of [
      "product.name",
      "product.gtin",
      "product.egais",
      "km.code",
      "shift.no",
      "date",
      "expiry",
      "operator",
      "counterparty.name",
    ] as const) {
      expect(labelFieldDisplayValue(field, data), field).toBe(data[field]);
    }
  });
});
