import {
  canonicalizeKm,
  kmHash,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { syncBatchSchema, syncBatchResponseOpenApiSchema } from "../src/modules/station-scans/dto";
import { zodApiSchema } from "../src/lib/openapi";

const GS = "\u001d";
const RAW = `]d2 010460068200001321abcDEF1234567${GS}93AbCd `;
const canonical = canonicalizeKm(RAW);

function body(overrides: Record<string, unknown> = {}) {
  return {
    batchId: "station:install:1",
    items: [
      {
        shiftId: "11111111-1111-1111-8111-111111111111",
        terminalId: "untrusted-terminal",
        raw: RAW,
        verdict: "ok",
        scannedAt: "2026-08-01T00:00:00.000Z",
        code: {
          codeHash: kmHash(canonical),
          gtin14: canonical.gtin14,
          serial: canonical.serial,
        },
        boxId: null,
        operatorId: null,
        ...overrides,
      },
    ],
    boxes: [],
    exceptions: [],
  };
}

function closure(overrides: Record<string, unknown> = {}) {
  return {
    boxId: "box-1",
    shiftId: "11111111-1111-1111-8111-111111111111",
    terminalId: "terminal-1",
    sscc: "046012345600000016",
    closedAt: "2026-08-13T10:00:00.000Z",
    operatorId: null,
    printVerifiedAt: null,
    printSkippedAt: null,
    ...overrides,
  };
}

describe("syncBatchSchema marking-code contract", () => {
  it("defaults the product label channel for legacy batches and rejects malformed events", () => {
    expect(syncBatchSchema.parse({ batchId: "legacy", items: [] }).productLabelEvents).toEqual([]);
    expect(
      syncBatchSchema.safeParse({ batchId: "new", items: [], productLabelEvents: [{}] }).success,
    ).toBe(false);
  });

  it("documents bounded product label events and explicit receipts", () => {
    const requestSchema = zodApiSchema(syncBatchSchema);
    expect(requestSchema.properties?.productLabelEvents).toMatchObject({
      type: "array",
      maxItems: 100,
    });
    expect(syncBatchResponseOpenApiSchema.properties?.productLabelReceipt).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["protocol", "acceptedEventIds", "quarantined"],
    });
  });
  it("derives canonicalRaw while preserving captured raw", () => {
    const parsed = syncBatchSchema.parse(body());
    expect(parsed.items[0]?.raw).toBe(RAW);
    expect(parsed.items[0]?.code?.canonicalRaw).toBe(`010460068200001321abcDEF1234567${GS}93AbCd`);
  });

  it("rejects forged hash, GTIN and serial claims", () => {
    const valid = body().items[0]!.code as Record<string, string>;
    for (const code of [
      { ...valid, codeHash: "0".repeat(64) },
      { ...valid, gtin14: "04600682000020" },
      { ...valid, serial: "other" },
    ]) {
      expect(syncBatchSchema.safeParse(body({ code })).success).toBe(false);
    }
  });

  it("requires code exactly for accepted scans and box membership", () => {
    expect(syncBatchSchema.safeParse(body({ verdict: "ok", code: null })).success).toBe(false);
    expect(syncBatchSchema.safeParse(body({ verdict: "invalid", code: null })).success).toBe(true);
    expect(
      syncBatchSchema.safeParse(body({ verdict: "invalid", code: null, boxId: "b1" })).success,
    ).toBe(false);
  });

  it("rejects values PostgreSQL text cannot store and enforces the byte limit", () => {
    expect(
      syncBatchSchema.safeParse(body({ verdict: "invalid", code: null, raw: "bad\0raw" })).success,
    ).toBe(false);
    expect(
      syncBatchSchema.safeParse(body({ verdict: "invalid", code: null, raw: "я".repeat(600) }))
        .success,
    ).toBe(false);
  });

  it("returns validation errors instead of throwing for malformed accepted codes", () => {
    expect(() => syncBatchSchema.safeParse(body({ raw: `${RAW}\ud800` }))).not.toThrow();
    expect(syncBatchSchema.safeParse(body({ raw: `${RAW}\ud800` })).success).toBe(false);
  });

  it("rejects a box closure that claims both verification outcomes", () => {
    expect(
      syncBatchSchema.safeParse({
        ...body(),
        boxes: [
          closure({
            printVerifiedAt: "2026-08-13T10:01:00.000Z",
            printSkippedAt: "2026-08-13T10:01:01.000Z",
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("treats a pre-06d box closure as a box that is simply not on a pallet", () => {
    const parsed = syncBatchSchema.parse({ ...body(), boxes: [closure()] });
    expect(parsed.boxes[0]?.devicePalletId).toBeNull();
    expect(parsed.pallets).toEqual([]);
    expect(parsed.palletExceptions).toEqual([]);
  });

  it("caps both pallet channels at the constant the devices' drain loops share", () => {
    const palletClosure = (n: number) => ({
      palletId: `p${n}`,
      shiftId: "11111111-1111-1111-8111-111111111111",
      terminalId: "terminal-1",
      sscc: "046012345600000016",
      closedAt: "2026-09-11T10:00:00.000Z",
      operatorId: null,
    });
    const atLimit = Array.from({ length: MAX_PALLET_CLOSURES_PER_SYNC_BATCH }, (_, i) =>
      palletClosure(i),
    );
    expect(syncBatchSchema.safeParse({ ...body(), pallets: atLimit }).success).toBe(true);
    expect(
      syncBatchSchema.safeParse({ ...body(), pallets: [...atLimit, palletClosure(999)] }).success,
    ).toBe(false);
  });

  it("rejects a pallet closure that claims both verification outcomes", () => {
    expect(
      syncBatchSchema.safeParse({
        ...body(),
        pallets: [
          {
            palletId: "p1",
            shiftId: "11111111-1111-1111-8111-111111111111",
            terminalId: "terminal-1",
            sscc: "046012345600000016",
            closedAt: "2026-09-11T10:00:00.000Z",
            operatorId: null,
            printVerifiedAt: "2026-09-11T10:01:00.000Z",
            printSkippedAt: "2026-09-11T10:01:01.000Z",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires a reason on every pallet exception and refuses an unknown kind", () => {
    const exception = (overrides: Record<string, unknown>) => ({
      kind: "disassemble",
      palletId: "p1",
      shiftId: "11111111-1111-1111-8111-111111111111",
      terminalId: "terminal-1",
      operatorId: null,
      reason: "повреждён поддон",
      occurredAt: "2026-09-11T10:00:00.000Z",
      ...overrides,
    });
    expect(syncBatchSchema.safeParse({ ...body(), palletExceptions: [exception({})] }).success).toBe(
      true,
    );
    // «Закрыть паллету досрочно» is an ordinary close, never an exception.
    expect(
      syncBatchSchema.safeParse({ ...body(), palletExceptions: [exception({ kind: "close" })] })
        .success,
    ).toBe(false);
    expect(
      syncBatchSchema.safeParse({ ...body(), palletExceptions: [exception({ reason: "" })] })
        .success,
    ).toBe(false);
  });

  it("rejects a box closure sscc that is the right length but not all digits", () => {
    // Length-only validation would accept this and let it reach storage,
    // where formatSsccWithAi (@markiro/domain) and the v2 boxes shift-export
    // both require exactly 18 digits and throw/error otherwise.
    expect(
      syncBatchSchema.safeParse({
        ...body(),
        boxes: [closure({ sscc: "12345678901234567X" })],
      }).success,
    ).toBe(false);
  });
});
