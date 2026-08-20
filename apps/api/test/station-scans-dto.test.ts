import { canonicalizeKm, kmHash } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { syncBatchSchema } from "../src/modules/station-scans/dto";

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
