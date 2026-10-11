import { describe, expect, it } from "vitest";
import {
  warehouseLookupRequestSchema,
  warehouseSourceSchema,
  warehouseTemplateSchema,
  warehouseEventBatchSchema,
  warehouseReceiptSchema,
  warehouseBoxSource,
  warehousePreparedEvent,
  warehouseBoxTemplate,
} from "../src/index.js";

describe("warehouse reprint boundaries", () => {
  it("does not accept client-supplied tenant or device scope", () => {
    const input = {
      raw: "!100346006820000000014",
      operatorId: "00000000-0000-4000-8000-000000000001",
      protocol: "warehouse-label-reprint-v1",
    };
    expect(warehouseLookupRequestSchema.safeParse(input).success).toBe(true);
    expect(warehouseLookupRequestSchema.safeParse({ ...input, tenantId: "other" }).success).toBe(
      false,
    );
    expect(warehouseLookupRequestSchema.safeParse({ ...input, deviceId: "other" }).success).toBe(
      false,
    );
  });
  it("checks the source barcode identity and payload digest", () => {
    const source = warehouseBoxSource();
    expect(warehouseSourceSchema.safeParse(source).success).toBe(true);
    expect(
      warehouseSourceSchema.safeParse({
        ...source,
        fields: { ...source.fields, sscc: "046006820000621515" },
      }).success,
    ).toBe(false);
    expect(
      warehouseSourceSchema.safeParse({ ...source, payloadDigest: "0".repeat(64) }).success,
    ).toBe(false);
  });
  it("rejects a box template claiming to be a product duplicate", () => {
    expect(warehouseTemplateSchema.safeParse(warehouseBoxTemplate()).success).toBe(true);
    expect(
      warehouseTemplateSchema.safeParse({ ...warehouseBoxTemplate(), purpose: "product_duplicate" })
        .success,
    ).toBe(false);
  });
  it("does not put printer bytes or full KM in events", () => {
    const event = warehousePreparedEvent();
    expect(
      warehouseEventBatchSchema.safeParse({
        protocol: "warehouse-label-reprint-v1",
        events: [event],
      }).success,
    ).toBe(true);
    expect(
      warehouseEventBatchSchema.safeParse({
        protocol: "warehouse-label-reprint-v1",
        events: [{ ...event, bytesBase64: "c2VjcmV0" }],
      }).success,
    ).toBe(false);
    expect(
      warehouseEventBatchSchema.safeParse({
        protocol: "warehouse-label-reprint-v1",
        events: Array.from({ length: 101 }, () => event),
      }).success,
    ).toBe(false);
  });
  it("refuses malformed acknowledgements", () => {
    expect(
      warehouseReceiptSchema.safeParse({
        protocol: "warehouse-label-reprint-v1",
        acceptedEventIds: ["wrong"],
        quarantined: [],
      }).success,
    ).toBe(false);
  });
});
