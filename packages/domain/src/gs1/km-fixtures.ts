import { DomainError } from "../errors.js";
import { validateShiftScan } from "../scan/validate.js";
import { canonicalizeKm, kmHash, kmKey } from "./km.js";

const GS = "\u001d";
const GTIN = "04600682000013";
const BASE = `01${GTIN}21abcDEF1234567`;

/**
 * Parse cases the handheld's Kotlin `KmCodec` must reproduce byte for byte:
 * the server recomputes hash, GTIN and serial from the raw scan and rejects a
 * whole batch on a mismatch. Exported to
 * `apps/handheld/app/src/test/resources/km-fixtures.json` by
 * `pnpm --filter @markiro/domain fixtures:km`; `test/km-fixtures.test.ts`
 * fails when the committed JSON drifts from this module.
 */
export interface KmParseFixture {
  name: string;
  raw: string;
  expected:
    | {
        canonicalRaw: string;
        gtin14: string;
        serial: string;
        ais: Record<string, string>;
        key: string;
        hash: string;
      }
    | { error: string };
}

export interface KmVerdictFixture {
  name: string;
  raw: string;
  expectedGtin14: string;
  /** Hashes the handheld pretends are already in its journal. */
  knownHashes: string[];
  verdict: "ok" | "duplicate" | "wrong_gtin" | "invalid";
}

export interface KmFixtures {
  parse: KmParseFixture[];
  verdict: KmVerdictFixture[];
}

const PARSE_CASES: { name: string; raw: string }[] = [
  { name: "plain gtin and serial", raw: BASE },
  { name: "crypto tail 93", raw: `${BASE}${GS}93AbCd` },
  { name: "crypto tail 91 92 93", raw: `${BASE}${GS}91EE07${GS}92dGVzdA==${GS}93AbCd` },
  { name: "aim prefix", raw: `]d2${BASE}${GS}93AbCd` },
  { name: "leading and trailing space and tab", raw: ` \t${BASE}\t ` },
  { name: "aim prefix then space", raw: `]d2 ${BASE}` },
  { name: "serial with symbols", raw: `01${GTIN}21!"%&'()*+,-./:;<=>?_` },
  { name: "serial of one character", raw: `01${GTIN}21x` },
  { name: "gtin13 zero padded", raw: `014600682000013` + `21x` },
  { name: "unicode serial", raw: `01${GTIN}21сериЯ` },
  { name: "exactly 1024 bytes", raw: `01${GTIN}21${"a".repeat(1024 - 18)}` },
  { name: "empty", raw: "" },
  { name: "only spaces", raw: "   " },
  { name: "sscc not a km", raw: "00346006820000000014" },
  { name: "plain gtin not a km", raw: GTIN },
  { name: "wrong first ai", raw: `02${GTIN}21x` },
  { name: "short gtin field", raw: `01046006820000` },
  { name: "gtin with letter", raw: `0104600682A00013` + `21x` },
  { name: "bad check digit", raw: `0104600682000014` + `21x` },
  { name: "missing serial ai", raw: `01${GTIN}` },
  { name: "empty serial", raw: `01${GTIN}21` },
  { name: "empty serial before gs", raw: `01${GTIN}21${GS}93AbCd` },
  { name: "terminal gs", raw: `${BASE}${GS}` },
  { name: "double gs", raw: `${BASE}${GS}${GS}93AbCd` },
  { name: "ai too short", raw: `${BASE}${GS}9` },
  { name: "ai two characters no value", raw: `${BASE}${GS}93` },
  { name: "non digit ai", raw: `${BASE}${GS}9xAbCd` },
  { name: "empty ai value then more", raw: `${BASE}${GS}91${GS}93AbCd` },
  { name: "duplicate ai", raw: `${BASE}${GS}93AbCd${GS}93EfGh` },
  { name: "newline inside", raw: `01${GTIN}21ab\ncd` },
  { name: "carriage return at end", raw: `${BASE}\r` },
  { name: "nul inside", raw: `01${GTIN}21ab\u0000cd` },
  { name: "del inside", raw: `01${GTIN}21ab\u007fcd` },
  { name: "replacement character", raw: `01${GTIN}21ab\ufffdcd` },
  { name: "unpaired high surrogate", raw: `01${GTIN}21ab\ud83dcd` },
  { name: "unpaired low surrogate", raw: `01${GTIN}21ab\ude00cd` },
  { name: "paired surrogate ok", raw: `01${GTIN}21ab😀cd` },
  { name: "1025 bytes", raw: `01${GTIN}21${"a".repeat(1024 - 17)}` },
  { name: "1024 bytes by utf8 not chars", raw: `01${GTIN}21${"я".repeat((1024 - 18) / 2)}` },
];

const VERDICT_CASES: KmVerdictFixture[] = [
  {
    name: "accepted",
    raw: `${BASE}${GS}93AbCd`,
    expectedGtin14: GTIN,
    knownHashes: [],
    verdict: "ok",
  },
  {
    name: "duplicate by hash ignoring crypto tail",
    raw: `${BASE}${GS}93ZZZZ`,
    expectedGtin14: GTIN,
    knownHashes: [kmHash(canonicalizeKm(`${BASE}${GS}93AbCd`))],
    verdict: "duplicate",
  },
  {
    name: "wrong gtin",
    raw: `${BASE}${GS}93AbCd`,
    expectedGtin14: "04600000000015",
    knownHashes: [],
    verdict: "wrong_gtin",
  },
  {
    name: "wrong gtin beats duplicate",
    raw: `${BASE}${GS}93AbCd`,
    expectedGtin14: "04600000000015",
    knownHashes: [kmHash(canonicalizeKm(BASE))],
    verdict: "wrong_gtin",
  },
  {
    name: "garbage is invalid",
    raw: "hello",
    expectedGtin14: GTIN,
    knownHashes: [],
    verdict: "invalid",
  },
  {
    name: "sscc is invalid",
    raw: "00346006820000000014",
    expectedGtin14: GTIN,
    knownHashes: [],
    verdict: "invalid",
  },
  {
    name: "plain gtin is invalid",
    raw: GTIN,
    expectedGtin14: GTIN,
    knownHashes: [],
    verdict: "invalid",
  },
  {
    name: "bad check digit is invalid",
    raw: `0104600682000014` + `21x`,
    expectedGtin14: GTIN,
    knownHashes: [],
    verdict: "invalid",
  },
];

export function buildKmFixtures(): KmFixtures {
  const parse = PARSE_CASES.map(({ name, raw }): KmParseFixture => {
    try {
      const km = canonicalizeKm(raw);
      return {
        name,
        raw,
        expected: {
          canonicalRaw: km.raw,
          gtin14: km.gtin14,
          serial: km.serial,
          ais: km.ais,
          key: kmKey(km),
          hash: kmHash(km),
        },
      };
    } catch (error) {
      if (error instanceof DomainError) return { name, raw, expected: { error: error.code } };
      throw error;
    }
  });
  const verdict = VERDICT_CASES.map((fixture) => {
    const known = new Set(fixture.knownHashes);
    const actual = validateShiftScan(fixture.raw, {
      expectedGtin14: fixture.expectedGtin14,
      isDuplicate: (key) => known.has(key),
    }).status;
    if (actual !== fixture.verdict) {
      throw new Error(
        `fixture ${fixture.name}: expected ${fixture.verdict}, domain says ${actual}`,
      );
    }
    return fixture;
  });
  return { parse, verdict };
}
