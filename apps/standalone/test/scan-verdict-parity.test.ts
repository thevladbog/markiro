import { readFileSync } from "node:fs";

import { canonicalizeKm, kmHash, validateShiftScan } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { HOST_MAX_SERIAL_BYTES, processScan } from "../src/floor/work/scan-pipeline.js";
import type { WorkShift } from "../src/floor/shifts/shift-copies.js";
import type { CodeCheck } from "../src/host/protocol.js";
import {
  ENTERED,
  enteredShift,
  GTIN,
  km,
  OTHER_GTIN,
  PAIRING,
  rows,
  scanContext,
  VALIDATION_ENTERED,
} from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";

/*
 * The verdict parity of a scan with the cloud (plan РЕЖ, A9). One table of raw scans — the
 * domain's KM fixtures (`packages/domain/src/gs1/km-fixtures.ts`, committed byte for byte as
 * `apps/handheld/.../km-fixtures.json` and checked there against the module) and a few rows of
 * what a line's scanner also hands over — must come out of the station's own path
 * (`processScan`: `readScan`, the product's GTIN, a duplicate this station or the host knows)
 * with the verdict the domain's `validateShiftScan`, which the cloud station validates by, gives
 * it; in a validation shift and in an aggregation one alike, since the verdict does not depend on
 * the mode. The one difference is deliberate: the host keeps a serial of 64 bytes at most
 * (`HOST_MAX_SERIAL_BYTES`), so a longer one, which the domain accepts, is unknown here.
 */

const testModuleUrl = import.meta.url;

const fixtures = z
  .object({
    parse: z.array(z.object({ name: z.string(), raw: z.string() })),
    verdict: z.array(
      z.object({
        name: z.string(),
        raw: z.string(),
        expectedGtin14: z.string(),
        knownHashes: z.array(z.string()),
        verdict: z.enum(["ok", "duplicate", "wrong_gtin", "invalid"]),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL("../../handheld/app/src/test/resources/km-fixtures.json", testModuleUrl),
        "utf8",
      ),
    ),
  );

interface Row {
  name: string;
  raw: string;
  expectedGtin14: string;
  knownHashes: readonly string[];
}

const GS = "\u001d";

/** What a line's scanner hands over besides the fixtures: AIM prefixes, a tail, a badge, rubbish. */
const LINE_ROWS: Row[] = [
  { name: "line: aim prefix and crypto tail", raw: km("5Yq'Ct;"), expectedGtin14: GTIN },
  { name: "line: no aim prefix", raw: km("Kq8vT2mXc5Rz", { aim: false }), expectedGtin14: GTIN },
  {
    name: "line: tails 91 92 93",
    raw: `]d201${GTIN}21Pw3nY7hLd9Fs${GS}91EE07${GS}92dGVzdA==${GS}93AbCd`,
    expectedGtin14: GTIN,
  },
  {
    name: "line: foreign gtin",
    raw: km("Gt5kR1wQe8Uv", { gtin: OTHER_GTIN }),
    expectedGtin14: GTIN,
  },
  { name: "line: sscc with its aim prefix", raw: "]C100346006820000000014", expectedGtin14: GTIN },
  { name: "line: ean-13 of the product", raw: "4600682000013", expectedGtin14: GTIN },
  { name: "line: badge-like digits", raw: "0000123456", expectedGtin14: GTIN },
  { name: "line: badge-like text", raw: "BADGE-7Q4K-0011", expectedGtin14: GTIN },
  { name: "line: rubbish", raw: "%%%", expectedGtin14: GTIN },
  {
    name: "line: serial of 64 bytes",
    raw: km("x".repeat(HOST_MAX_SERIAL_BYTES)),
    expectedGtin14: GTIN,
  },
  {
    name: "line: serial of 65 bytes",
    raw: km("x".repeat(HOST_MAX_SERIAL_BYTES + 1)),
    expectedGtin14: GTIN,
  },
].map((row) => ({ ...row, knownHashes: [] }));

const TABLE: Row[] = [
  ...fixtures.verdict,
  ...fixtures.parse.map((row) => ({ ...row, expectedGtin14: GTIN, knownHashes: [] })),
  ...LINE_ROWS,
];

/** The rows whose serial the host would not keep: the domain accepts them, the station not. */
const LONG_SERIALS = new Set([
  "exactly 1024 bytes",
  "1024 bytes by utf8 not chars",
  "line: serial of 65 bytes",
]);

type Verdict = "ok" | "duplicate" | "wrong_gtin" | "invalid";

function domainVerdict(row: Row): { verdict: Verdict; key: string | null } {
  const known = new Set(row.knownHashes);
  const verdict = validateShiftScan(row.raw, {
    expectedGtin14: row.expectedGtin14,
    isDuplicate: (key) => known.has(key),
  });
  return { verdict: verdict.status, key: "key" in verdict ? verdict.key : null };
}

const MODES = [
  ["validation", VALIDATION_ENTERED],
  ["aggregation", ENTERED],
] as const;

/**
 * The station's verdict for the row in a fresh station: the shift's product has the row's
 * GTIN, and a known hash is held by this station (`local`) or owned on the host (`host`).
 */
async function stationVerdict(
  row: Row,
  entered: (typeof MODES)[number][1],
  knownBy: "local" | "host",
): Promise<{ verdict: Verdict; key: string | null }> {
  const { db, executor } = openLocalDb();
  const stored = await enteredShift(executor, entered);
  const shift: WorkShift = {
    ...stored,
    snapshot: {
      ...stored.snapshot,
      product: { ...stored.snapshot.product, gtin14: row.expectedGtin14 },
    },
  };
  if (knownBy === "local") {
    for (const [index, codeHash] of row.knownHashes.entries()) {
      db.prepare(
        "INSERT INTO floor_codes (host_id, device_id, code_hash, shift_id, box_id, scan_id, " +
          "scanned_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
      ).run(
        PAIRING.hostId,
        PAIRING.deviceId,
        codeHash,
        shift.copy.id,
        `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        "2026-10-08T06:00:00.000Z",
      );
    }
  }
  const known = new Set(knownBy === "host" ? row.knownHashes : []);
  const outcome = await processScan(
    scanContext(executor, shift, {
      online: () => true,
      checkCode: async (codeHash): Promise<CodeCheck> =>
        known.has(codeHash)
          ? {
              status: "taken",
              owner: {
                shiftId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
                shiftNumber: "OCT26-003",
                deviceId: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
                scannedAt: "2026-10-08T05:58:41.090Z",
                sameDevice: false,
              },
            }
          : { status: "free" },
    }),
    row.raw,
  );
  const [journalled] = rows(db, "SELECT code_hash FROM floor_scans");
  const key = journalled?.["code_hash"];
  const verdict: Verdict = outcome.kind === "accepted" ? "ok" : outcome.kind;
  return { verdict, key: typeof key === "string" ? key : null };
}

describe("the verdict of a scan, the station's and the cloud's (plan РЕЖ, A9)", () => {
  it("reads every case of the domain's verdict and parse fixtures", () => {
    expect(fixtures.verdict.map((row) => row.verdict)).toEqual(
      expect.arrayContaining(["ok", "duplicate", "wrong_gtin", "invalid"]),
    );
    expect(fixtures.parse.length).toBeGreaterThan(30);
  });

  it("keeps the fixtures' own verdicts in the domain", () => {
    for (const row of fixtures.verdict) {
      expect(domainVerdict(row).verdict, row.name).toBe(row.verdict);
    }
  });

  describe.each(MODES)("in the %s shift", (_mode, entered) => {
    it.each(TABLE.map((row) => [row.name, row] as const))("%s", async (_name, row) => {
      const cloud = domainVerdict(row);
      for (const knownBy of row.knownHashes.length === 0
        ? (["local"] as const)
        : (["local", "host"] as const)) {
        const station = await stationVerdict(row, entered, knownBy);
        if (LONG_SERIALS.has(row.name)) {
          expect(cloud.verdict, row.name).toBe("ok");
          expect(station, row.name).toEqual({ verdict: "invalid", key: null });
          continue;
        }
        expect(station.verdict, `${row.name} (${knownBy})`).toBe(cloud.verdict);
        // The same code is the same duplicate key: the hash without the crypto tail.
        if (cloud.verdict === "ok" || cloud.verdict === "duplicate") {
          expect(station.key, row.name).toBe(cloud.key);
        }
      }
    });
  });

  it("differs only where the host would not keep the serial", () => {
    for (const row of TABLE.filter((each) => LONG_SERIALS.has(each.name))) {
      const serial = canonicalizeKm(row.raw).serial;
      expect(new TextEncoder().encode(serial).length, row.name).toBeGreaterThan(
        HOST_MAX_SERIAL_BYTES,
      );
    }
    for (const row of TABLE.filter((each) => !LONG_SERIALS.has(each.name))) {
      if (domainVerdict(row).verdict !== "ok") continue;
      const serial = canonicalizeKm(row.raw).serial;
      expect(new TextEncoder().encode(serial).length, row.name).toBeLessThanOrEqual(
        HOST_MAX_SERIAL_BYTES,
      );
    }
  });

  it("keys a duplicate by the hash without the crypto tail, as the domain", () => {
    const [duplicate] = fixtures.verdict.filter((row) => row.verdict === "duplicate");
    if (duplicate === undefined) throw new Error("the fixtures have a duplicate");
    expect(duplicate.knownHashes).toEqual([kmHash(canonicalizeKm(duplicate.raw))]);
  });
});
