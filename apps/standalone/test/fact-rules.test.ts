import { readFileSync } from "node:fs";

import {
  boxMembershipDigestV1,
  buildSscc,
  SHIFT_CLOSE_REASON_CODES,
  shiftCloseReasonRequired,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../proto/fixtures/${name}`, testModuleUrl), "utf8"));
}

/**
 * The rules of facts the host (`host/src/facts/rules.rs`) and the domain
 * must answer alike, each read strictly from the fixture both sides read.
 */
const BOX_DIGEST = z
  .strictObject({
    cases: z.array(z.strictObject({ hashes: z.array(z.string()), digest: z.string() })),
  })
  .parse(fixture("box-digest.json"));

const CLOSE_REASONS = z
  .strictObject({
    codes: z.array(z.string()),
    required: z.array(
      z.strictObject({
        plannedQty: z.number().int().nullable(),
        actualQty: z.number().int(),
        required: z.boolean(),
      }),
    ),
  })
  .parse(fixture("shift-close-reasons.json"));

const INSTANTS = z
  .strictObject({ valid: z.array(z.string()), invalid: z.array(z.string()) })
  .parse(fixture("device-instants.json"));

const SSCC_SERIALS = z
  .strictObject({
    cases: z.array(
      z.strictObject({
        extension: z.number().int(),
        issuerPrefix: z.string(),
        serial: z.number().int(),
        sscc: z.string(),
      }),
    ),
  })
  .parse(fixture("sscc-serials.json"));

describe("fact rules: the fixtures the host's facts answer too", () => {
  it("holds 5 box digests, 6 close cases, 22 instants and 7 SSCCs", () => {
    expect([
      BOX_DIGEST.cases.length,
      CLOSE_REASONS.required.length,
      INSTANTS.valid.length + INSTANTS.invalid.length,
      SSCC_SERIALS.cases.length,
    ]).toEqual([5, 6, 22, 7]);
  });

  // The host reads the first 17 digits of a box's or a pallet's SSCC as
  // these three fields (`rules::names_serial`).
  it.each(SSCC_SERIALS.cases)(
    "builds the SSCC of extension $extension, prefix $issuerPrefix and serial $serial",
    (entry) => {
      expect(buildSscc(entry.extension, entry.issuerPrefix, entry.serial)).toBe(entry.sscc);
    },
  );

  it.each(BOX_DIGEST.cases)("digests the members $hashes as the domain does", (entry) => {
    expect(boxMembershipDigestV1(entry.hashes)).toBe(entry.digest);
  });

  it("lists the domain's six close reasons in its order", () => {
    expect(CLOSE_REASONS.codes).toEqual([...SHIFT_CLOSE_REASON_CODES]);
  });

  it.each(CLOSE_REASONS.required)(
    "needs a reason for plan $plannedQty and fact $actualQty: $required",
    (entry) => {
      expect(shiftCloseReasonRequired(entry.plannedQty, entry.actualQty)).toBe(entry.required);
    },
  );

  // A station writes its instants with `Date.toISOString`: a valid one is
  // what that writes back, of 24 characters (the years 0000–9999; the host
  // takes no six-digit year), an invalid one is not.
  it.each(INSTANTS.valid)("writes %j back unchanged", (text) => {
    expect(new Date(text).toISOString()).toBe(text);
  });

  it.each(INSTANTS.invalid)("never writes %j", (text) => {
    const at = new Date(text);
    expect(Number.isNaN(at.getTime()) || at.toISOString() !== text || text.length !== 24).toBe(
      true,
    );
  });
});

/**
 * Cases the shared fixtures do not hold, which `host/tests/fact_rules.rs`
 * asserts with the same literals (the digests were computed outside both
 * languages, with Python's `hashlib`): the host and the domain must answer
 * them alike too.
 */
function isWritten(text: string): boolean {
  const at = new Date(text);
  return !Number.isNaN(at.getTime()) && at.toISOString() === text && text.length === 24;
}

describe("fact rules: cases beyond the fixtures", () => {
  const hash = (pair: string): string => pair.repeat(32);
  const zeros = (lead: string): string => `${lead}${"0".repeat(63)}`;

  it.each([
    [[hash("0f"), hash("a1")], "1d1624cccee200f0b1330457d822e12ec006e3d7fccff4567df9e6e812251d5d"],
    [[hash("a1"), hash("0f")], "1d1624cccee200f0b1330457d822e12ec006e3d7fccff4567df9e6e812251d5d"],
    [
      [zeros("9"), zeros("a"), zeros("0")],
      "30785ba5ff8995a049fedd3d6a47c68f2abc3aa8f8df94f09e30ccb7c2cc9da9",
    ],
    [
      [zeros("a"), zeros("0"), zeros("9")],
      "30785ba5ff8995a049fedd3d6a47c68f2abc3aa8f8df94f09e30ccb7c2cc9da9",
    ],
  ])("digests the members %j as the host does", (members, digest) => {
    expect(boxMembershipDigestV1(members)).toBe(digest);
  });

  // The host's digest keeps duplicates and takes any text; the domain
  // refuses both, so the host must check its members before it digests.
  it("refuses duplicate and malformed members, which the host checks before it digests", () => {
    expect(() => boxMembershipDigestV1([hash("a1"), hash("a1")])).toThrow("duplicate");
    expect(() => boxMembershipDigestV1(["a".repeat(64), "B".repeat(64)])).toThrow("invalid");
    expect(() => boxMembershipDigestV1(["a".repeat(63)])).toThrow("invalid");
  });

  it.each([
    [null, 0, false],
    [null, 4_294_967_295, false],
    [0, 0, false],
    [0, 1, true],
    [1, 1, false],
    [1, 2, true],
    [10_000_000, 10_000_000, false],
    [10_000_000, 9_999_999, true],
    [10_000_000, 10_000_001, true],
    [4_294_967_295, 4_294_967_295, false],
    [4_294_967_295, 4_294_967_294, true],
  ])("needs a reason for plan %j and fact %j: %j", (planned, actual, required) => {
    expect(shiftCloseReasonRequired(planned, actual)).toBe(required);
  });

  it.each([
    "1970-01-01T00:00:00.000Z",
    "0000-01-01T00:00:00.000Z",
    "2024-02-29T12:00:00.001Z",
    "2026-10-08T00:00:00.010Z",
    "2026-10-08T00:00:00.100Z",
    "2000-02-29T06:02:00.123Z",
    "2026-10-08T23:59:59.999Z",
  ])("writes %j back unchanged", (text) => {
    expect(isWritten(text)).toBe(true);
  });

  it.each([
    "2016-12-31T23:59:60.000Z",
    "2016-12-31T23:59:60Z",
    "2026-10-08T06:02:00.123456Z",
    "2026-10-08T06:02:00.123456789Z",
    "2026-10-08T06:02:00.123z",
    "2026-10-08t06:02:00.123Z",
    "2026-10-08T06:02:00.123+00:00",
    "2026-10-08T06:02:00.123-00:00",
    "2026-10-08T06:02:00.123 Z",
    "2026-10-08T06:02:00,123Z",
    "2026-10-08T06:02Z",
    "20261008T060200.123Z",
    "2026-10-08T6:02:00.123Z",
    "2026-1-08T06:02:00.123Z",
    "-000001-10-08T06:02:00.123Z",
    "+010000-10-08T06:02:00.123Z",
    "２０２６-10-08T06:02:00.123Z",
    "2026-10-08T06:02:00.123Z\n",
    "2026-10-08T06:02:00.123Z\0",
    "2026-02-29T06:02:00.123Z",
    "2100-02-29T06:02:00.123Z",
    "1900-02-29T06:02:00.123Z",
    "2026-04-31T06:02:00.123Z",
    "2026-00-10T06:02:00.123Z",
    "2026-10-00T06:02:00.123Z",
    "2026-10-08T06:02:60.123Z",
  ])("never writes %j", (text) => {
    expect(isWritten(text)).toBe(false);
  });

  it("orders the texts of instants as it orders the instants", () => {
    const texts = [
      "0000-01-01T00:00:00.000Z",
      "0001-01-01T00:00:00.000Z",
      "0999-12-31T23:59:59.999Z",
      "1970-01-01T00:00:00.000Z",
      "2026-10-08T00:00:00.000Z",
      "2026-10-08T00:00:00.001Z",
      "2026-10-08T00:00:00.010Z",
      "2026-10-08T00:00:00.100Z",
      "2026-10-08T00:00:01.000Z",
      "2026-10-08T00:01:00.000Z",
      "2026-10-08T01:00:00.000Z",
      "2026-10-09T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ];
    for (const text of texts) expect(isWritten(text)).toBe(true);
    expect([...texts].sort()).toEqual(texts);
    expect(texts.map((text) => new Date(text).getTime())).toEqual(
      [...texts.map((text) => new Date(text).getTime())].sort((a, b) => a - b),
    );
  });
});
