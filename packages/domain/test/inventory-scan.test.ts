import { describe, expect, it } from "vitest";

import { canonicalizeKm, kmHash } from "../src/gs1/km.js";
import {
  classifyInventoryScan,
  type InventoryLocalClaim,
  type InventoryScanSnapshotRow,
} from "../src/inventory/scan.js";

const GTIN = "04600000000015";
const OTHER_GTIN = "04600682000013";
const SSCC = "346006820000000014";
const GS = "\u001d";

function raw(serial: string, gtin14 = GTIN): string {
  return `01${gtin14}21${serial}${GS}91KEY${GS}92SIGNATURE`;
}

function row(
  serial: string,
  values: Partial<InventoryScanSnapshotRow> = {},
): InventoryScanSnapshotRow {
  const km = canonicalizeKm(raw(serial));
  return {
    codeHash: kmHash(km),
    canonicalRaw: km.raw,
    gtin14: km.gtin14,
    serial: km.serial,
    sourceStatus: "INTRODUCED",
    sourceState: null,
    expected: true,
    protected: false,
    parentSscc: null,
    ...values,
  };
}

function classify(
  scannerRaw: string,
  rows: InventoryScanSnapshotRow[],
  claims: InventoryLocalClaim[] = [],
) {
  const rowsByHash = new Map(rows.map((item) => [item.codeHash, item]));
  const claimsByHash = new Map(claims.map((claim) => [claim.codeHash, claim]));
  return classifyInventoryScan(scannerRaw, {
    taskGtin14: GTIN,
    findSnapshotCode: (codeHash) => rowsByHash.get(codeHash) ?? null,
    findSnapshotChildren: (parentSscc) => rows.filter((item) => item.parentSscc === parentSscc),
    findLocalClaim: (codeHash) => claimsByHash.get(codeHash) ?? null,
  });
}

describe("inventory scan classification", () => {
  it("canonicalizes a prefixed KM with GS separators and accepts only an expected snapshot claim", () => {
    const expected = row("EXPECTED-1");

    expect(classify(` \t]d2${raw("EXPECTED-1")}\t `, [expected])).toMatchObject({
      kind: "expected",
      scanKind: "item",
      codeHash: expected.codeHash,
      canonicalRaw: expected.canonicalRaw,
      serial: "EXPECTED-1",
      originClassification: "expected",
    });
  });

  it("rejects a structurally valid KM for another GTIN without exposing its raw payload", () => {
    expect(classify(raw("OTHER", OTHER_GTIN), [])).toEqual({
      kind: "invalid",
      reason: "wrong_gtin",
    });
  });

  it.each(["EMITTED", "APPLIED", "RETIRED", "WRITTEN_OFF", "DISAGGREGATION"] as const)(
    "keeps %s as a known ineligible physical discrepancy",
    (sourceStatus) => {
      const known = row(sourceStatus, { sourceStatus, expected: false });
      expect(classify(known.canonicalRaw, [known])).toMatchObject({
        kind: "known-ineligible",
        originClassification: "known-ineligible",
        sourceStatus,
      });
    },
  );

  it("protects MOVING_BY_UD even when a corrupt snapshot flag says expected", () => {
    const protectedRow = row("MOVING", {
      sourceState: "MOVING_BY_UD",
      expected: true,
      protected: false,
    });
    expect(classify(protectedRow.canonicalRaw, [protectedRow])).toMatchObject({
      kind: "protected",
      originClassification: "protected",
    });
  });

  it("durably classifies a valid same-product KM absent from the snapshot as unknown", () => {
    expect(classify(raw("PHYSICAL-ONLY"), [])).toMatchObject({
      kind: "unknown",
      scanKind: "item",
      serial: "PHYSICAL-ONLY",
    });
  });

  it("returns the first winning terminal and time for a local duplicate", () => {
    const expected = row("DUPLICATE");
    expect(
      classify(
        expected.canonicalRaw,
        [expected],
        [
          {
            codeHash: expected.codeHash,
            eventId: "event-first",
            deviceId: "STA-01",
            scannedAt: "2026-08-25T10:00:00.000Z",
          },
        ],
      ),
    ).toMatchObject({
      kind: "duplicate",
      scanKind: "item",
      firstWinning: {
        eventId: "event-first",
        deviceId: "STA-01",
        scannedAt: "2026-08-25T10:00:00.000Z",
      },
    });
  });

  it("expands one known SSCC into the exact mixed active-snapshot membership", () => {
    const expected = row("BOX-EXPECTED", { parentSscc: SSCC });
    const protectedRow = row("BOX-PROTECTED", {
      parentSscc: SSCC,
      sourceState: "MOVING_BY_UD",
      expected: false,
      protected: true,
    });
    const ineligible = row("BOX-APPLIED", {
      parentSscc: SSCC,
      sourceStatus: "APPLIED",
      expected: false,
    });
    const outside = row("OUTSIDE", { parentSscc: "004600000000000015" });

    const result = classify(`]C1(00)${SSCC}`, [expected, protectedRow, ineligible, outside]);
    expect(result).toMatchObject({ kind: "expected", scanKind: "known_box", sscc: SSCC });
    if (result.kind !== "expected" || result.scanKind !== "known_box") {
      throw new Error("expected a known box");
    }
    expect(
      result.children.map(({ codeHash, originClassification }) => ({
        codeHash,
        originClassification,
      })),
    ).toEqual([
      { codeHash: expected.codeHash, originClassification: "expected" },
      { codeHash: protectedRow.codeHash, originClassification: "protected" },
      { codeHash: ineligible.codeHash, originClassification: "known-ineligible" },
    ]);
  });

  it("uses protected as the known-box verdict when no unclaimed expected child remains", () => {
    const alreadyExpected = row("BOX-EXPECTED-DONE", { parentSscc: SSCC });
    const protectedRow = row("BOX-PROTECTED-OPEN", {
      parentSscc: SSCC,
      sourceState: "MOVING_BY_UD",
      expected: true,
      protected: false,
    });

    expect(
      classify(
        SSCC,
        [alreadyExpected, protectedRow],
        [
          {
            codeHash: alreadyExpected.codeHash,
            eventId: "event-expected-first",
            deviceId: "STA-01",
            scannedAt: "2026-08-25T09:00:00.000Z",
          },
        ],
      ),
    ).toMatchObject({
      kind: "protected",
      scanKind: "known_box",
      originClassification: "protected",
    });
  });

  it("uses known-ineligible as the known-box verdict when it is the only unclaimed origin", () => {
    const alreadyExpected = row("BOX-EXPECTED-DONE-2", { parentSscc: SSCC });
    const ineligible = row("BOX-INELIGIBLE-OPEN", {
      parentSscc: SSCC,
      sourceStatus: "APPLIED",
      expected: false,
    });

    expect(
      classify(
        SSCC,
        [alreadyExpected, ineligible],
        [
          {
            codeHash: alreadyExpected.codeHash,
            eventId: "event-expected-first",
            deviceId: "STA-01",
            scannedAt: "2026-08-25T09:00:00.000Z",
          },
        ],
      ),
    ).toMatchObject({
      kind: "known-ineligible",
      scanKind: "known_box",
      originClassification: "known-ineligible",
    });
  });

  it("lets an unclaimed expected child dominate protected and ineligible box children", () => {
    const expected = row("BOX-EXPECTED-OPEN", { parentSscc: SSCC });
    const protectedRow = row("BOX-PROTECTED-OPEN-2", {
      parentSscc: SSCC,
      sourceState: "MOVING_BY_UD",
    });
    const ineligible = row("BOX-INELIGIBLE-OPEN-2", {
      parentSscc: SSCC,
      sourceStatus: "RETIRED",
      expected: false,
    });

    expect(classify(SSCC, [expected, protectedRow, ineligible])).toMatchObject({
      kind: "expected",
      scanKind: "known_box",
      originClassification: "expected",
    });
  });

  it("treats a known-box rescan with no unclaimed child as duplicate", () => {
    const child = row("BOX-DUP", { parentSscc: SSCC });
    expect(
      classify(
        `00${SSCC}`,
        [child],
        [
          {
            codeHash: child.codeHash,
            eventId: "event-first",
            deviceId: "STA-02",
            scannedAt: "2026-08-25T11:00:00.000Z",
          },
        ],
      ),
    ).toMatchObject({
      kind: "duplicate",
      scanKind: "known_box",
      firstWinning: { deviceId: "STA-02" },
    });
  });

  it("does not report an SSCC with zero snapshot children as a successful empty box", () => {
    expect(classify(SSCC, [])).toEqual({ kind: "unknown", scanKind: "old_box", sscc: SSCC });
  });

  it.each(["", "operator-pin-1234", "4006381333931", `010${"x".repeat(2000)}`])(
    "returns a closed safe invalid result for scanner noise %j",
    (scannerRaw) => {
      expect(classify(scannerRaw, [])).toMatchObject({ kind: "invalid" });
      expect(JSON.stringify(classify(scannerRaw, []))).not.toContain(scannerRaw || "operator-pin");
    },
  );
});
