// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  duplicatePayloadDigest,
  parseDuplicateKm,
  productLabelBytesDigest,
  productLabelValueDigest,
  type RasterResult,
} from "@markiro/domain";
import {
  duplicateLabelFields,
  prepareProductLabelAcceptance,
} from "../src/lib/product-labels/fields.js";
import type { PrepareProductLabelInput } from "../src/lib/product-labels/types.js";
import { productLabelAcceptanceFixture } from "./support/product-labels.js";

function input(dpi: 203 | 300 = 203): PrepareProductLabelInput {
  const fixture = productLabelAcceptanceFixture();
  const snapshot = {
    id: fixture.policy.snapshot.id,
    name: fixture.policy.snapshot.name,
    spec: { ...fixture.policy.snapshot.spec, dpi },
  };
  return {
    jobId: fixture.jobId,
    shiftId: fixture.shiftId,
    deviceId: fixture.deviceId,
    terminalId: fixture.terminalId,
    operatorId: fixture.operatorId,
    credentialOwnership: fixture.credentialOwnership,
    raw: fixture.raw,
    acceptedAt: "2026-09-08T21:30:00.000Z",
    policy: {
      ...fixture.policy,
      snapshot: { ...snapshot, digest: productLabelValueDigest(snapshot) },
    },
    labelContext: {
      productName: "Сироп «Клюква»",
      productPrintName: null,
      gtin14: fixture.gtin14,
      egaisCode: null,
      shelfLifeDays: 30,
      operatorName: null,
      counterpartyName: null,
      productionDate: "2026-09-08",
      shiftNumber: null,
    },
    eventId: fixture.preparedEvent.eventId,
    attemptId: fixture.preparedEvent.attemptId,
    language: "zpl",
    printerDpi: dpi,
    rasterizeText: vi.fn(async (): Promise<RasterResult> => ({
      hex: "00",
      totalBytes: 1,
      bytesPerRow: 1,
      width: 8,
      height: 1,
    })),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("duplicate label preparation", () => {
  it("uses the same full code, one unit, product fallback and declared production date", () => {
    const value = input();
    const fields = duplicateLabelFields({
      ...value.labelContext,
      canonicalRaw: value.raw,
      acceptedAt: value.acceptedAt,
    });
    expect(fields["km.code"]).toBe(parseDuplicateKm(value.raw).raw);
    expect(fields.qty).toBe("1");
    expect(fields.sscc).toBe("");
    expect(fields.date).toBe("08.09.2026");
    expect(fields.expiry).toBe("08.10.2026");
    expect(fields["product.printName"]).toBe("Сироп «Клюква»");
  });

  it.each([203, 300] as const)(
    "prints the short product name in the stock label at %i dpi",
    async (dpi) => {
      const { buildDuplicateLabelTemplate } = await import("@markiro/domain");
      const value = input(dpi);
      const snapshot = {
        id: value.policy.snapshot.id,
        name: `Дубликат Data Matrix 58×40 (${dpi} dpi)`,
        spec: buildDuplicateLabelTemplate(dpi),
      };
      const result = await prepareProductLabelAcceptance({
        ...value,
        policy: {
          ...value.policy,
          snapshot: { ...snapshot, digest: productLabelValueDigest(snapshot) },
        },
        labelContext: {
          ...value.labelContext,
          productName: "Full product description",
          productPrintName: "Keg 30 L",
        },
      });
      const printed = Buffer.from(result.bytesBase64, "base64").toString("latin1");
      expect(result.fields["product.printName"]).toBe("Keg 30 L");
      expect(printed).toContain("Keg 30 L");
      expect(printed).not.toContain("Full product description");
      expect(printed).toContain(dpi === 203 ? "^PW464" : "^PW685");
      expect(printed).toContain(dpi === 203 ? "^LL320" : "^LL472");
    },
  );

  it("uses the acceptance instant's local day only when the declared day is absent", () => {
    const value = input();
    const context = {
      ...value.labelContext,
      productionDate: null,
      canonicalRaw: value.raw,
      acceptedAt: value.acceptedAt,
    };
    vi.stubEnv("TZ", "UTC");
    expect(duplicateLabelFields(context).date).toBe("08.09.2026");
    vi.stubEnv("TZ", "Europe/Moscow");
    expect(duplicateLabelFields(context).date).toBe("09.09.2026");
    expect(duplicateLabelFields({ ...context, productionDate: "2026-09-08" }).date).toBe(
      "08.09.2026",
    );
  });

  it.each([
    { language: "zpl", dpi: 203 },
    { language: "tspl", dpi: 203 },
    { language: "zpl", dpi: 300 },
    { language: "tspl", dpi: 300 },
  ] as const)(
    "prepares immutable raster bytes for $language at $dpi dpi independently of the template language",
    async ({ language, dpi }) => {
      const value = { ...input(dpi), language };
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
      const first = await prepareProductLabelAcceptance(value);
      vi.setSystemTime(new Date("2026-09-10T00:00:00Z"));
      expect(await prepareProductLabelAcceptance(value)).toEqual(first);
      const bytes = Buffer.from(first.bytesBase64, "base64");
      const text = bytes.toString("latin1");
      expect(text).toContain(language === "zpl" ? "^GFA" : "BITMAP");
      expect(text).not.toContain(language === "zpl" ? "^BX" : "DMATRIX");
      expect(first.preparedEvent.bytesDigest).toBe(productLabelBytesDigest(bytes));
      expect(first.preparedEvent.payloadDigest).toBe(duplicatePayloadDigest(value.raw));
      expect(first.preparedEvent.occurredAt).toBe(value.acceptedAt);
      expect(first.fields.date).toBe("08.09.2026");
      expect(first.fields["km.code"]).toBe(parseDuplicateKm(value.raw).raw);
      expect(first.preparedEvent.language).toBe(language);
      expect(first.preparedEvent.dpi).toBe(dpi);
    },
  );

  it.each([null, 300] as const)(
    "rejects unknown or mismatching printer DPI before rendering: %s",
    async (printerDpi) => {
      const value = { ...input(), printerDpi };
      await expect(prepareProductLabelAcceptance(value)).rejects.toMatchObject({
        code: "PRODUCT_LABEL_PRINTER_DPI_MISMATCH",
      });
      expect(value.rasterizeText).not.toHaveBeenCalled();
    },
  );

  it("rejects inconsistent or incomplete product context before rendering", async () => {
    const value = input();
    for (const context of [
      { ...value.labelContext, productName: "" },
      { ...value.labelContext, gtin14: "04600000000022" },
      { ...value.labelContext, productionDate: "2026-02-30" },
      { ...value.labelContext, shelfLifeDays: NaN },
    ]) {
      await expect(
        prepareProductLabelAcceptance({ ...value, labelContext: context }),
      ).rejects.toThrow();
    }
    expect(value.rasterizeText).not.toHaveBeenCalled();
  });

  it("propagates raster failure without producing an acceptance command", async () => {
    const value = input();
    value.rasterizeText = vi.fn(async () => {
      throw new Error("raster unavailable");
    });
    await expect(prepareProductLabelAcceptance(value)).rejects.toThrow("raster unavailable");
  });
});
