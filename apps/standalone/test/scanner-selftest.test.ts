import { describe, expect, it } from "vitest";

import {
  GS,
  GS_MARK,
  HISTORY_SIZE,
  judgeScan,
  makeSelfTestCode,
  makeTestDataMatrix,
  maskScan,
  pushHistory,
  TEST_GTIN,
  visible,
  type SelfTestEntry,
} from "../src/floor/setup/scanner-selftest.js";

const EXPECTED = `01${TEST_GTIN}21TESTK3M7D4${GS}91TEST${GS}92TESTA3C7D9E4F8H3K7M4N9P3R7T4W8X3Y7A4C9D`;
/** `EXPECTED` typed with the Russian layout on: digits stay, capitals turn Cyrillic. */
const IN_RUSSIAN = EXPECTED.replace(/[A-Z]/g, (letter) => {
  const map: Record<string, string> = {
    A: "Ф",
    C: "С",
    D: "В",
    E: "У",
    F: "А",
    H: "Р",
    K: "Л",
    M: "Ь",
    N: "Т",
    P: "З",
    R: "К",
    T: "Е",
    W: "Ц",
    X: "Ч",
    Y: "Н",
  };
  return map[letter] ?? letter;
});

describe("the test DataMatrix", () => {
  it("has a valid GTIN of the restricted range, the real separators and a fresh serial every time", () => {
    const first = makeTestDataMatrix();
    const second = makeTestDataMatrix();
    expect(first).not.toBe(second);
    expect(first.startsWith(`01${TEST_GTIN}21TEST`)).toBe(true);
    expect(first.split(GS)).toHaveLength(3);
    expect(first.split(GS)[1]).toBe("91TEST");
    expect(first.split(GS)[2]?.startsWith("92TEST")).toBe(true);
    expect(TEST_GTIN).toMatch(/^02\d{12}$/);
    expect(TEST_GTIN).toHaveLength(14);
  });

  it("makes the plain code the cloud station makes", () => {
    expect(makeSelfTestCode("plain")).toMatch(/^MKR-[3-9A-Y]{6}$/);
    expect(makeSelfTestCode("dm")).toContain(GS);
  });
});

describe("judgeScan on a DataMatrix with separators", () => {
  it("is OK when the code arrives whole, and reads it as a marking code", () => {
    const verdict = judgeScan(EXPECTED, EXPECTED, "keyboard");
    expect(verdict).toMatchObject({
      status: "ok",
      reason: "match",
      channel: "keyboard",
      type: "km",
      groupSeparators: 2,
      expectedGroupSeparators: 2,
      length: EXPECTED.length,
    });
    expect(verdict.structure.map((item) => item.ai)).toEqual(["01", "21", "91", "92"]);
    expect(verdict.structure[0]?.checkDigitValid).toBe(true);
  });

  it("calls lost separators by name (a wedge scanner not set to send GS)", () => {
    const verdict = judgeScan(EXPECTED.replaceAll(GS, ""), EXPECTED, "keyboard");
    expect(verdict).toMatchObject({ status: "problem", reason: "gsLost", groupSeparators: 0 });
  });

  it("calls a separator sent as another character by that character", () => {
    const verdict = judgeScan(EXPECTED.replaceAll(GS, "|"), EXPECTED, "com");
    expect(verdict).toMatchObject({ status: "problem", reason: "gsReplaced", found: "|" });
  });

  it("calls a separator sent as a control character by its code", () => {
    const verdict = judgeScan(EXPECTED.replaceAll(GS, "\u001c"), EXPECTED, "com");
    expect(verdict).toMatchObject({ reason: "gsReplaced", found: "<1C>" });
  });

  it("calls a separator sent as text («<GS>») by that text", () => {
    const verdict = judgeScan(EXPECTED.replaceAll(GS, "<GS>"), EXPECTED, "com");
    expect(verdict).toMatchObject({ reason: "gsReplaced", found: "<GS>" });
  });

  it("accepts a separator typed as Ctrl+] (the wedge source reads it as GS) as a match", () => {
    expect(judgeScan(EXPECTED, EXPECTED, "keyboard").reason).toBe("match");
  });

  it("warns about a symbology prefix, naming it, since the station strips it", () => {
    expect(judgeScan(`]d2${EXPECTED}`, EXPECTED, "com")).toMatchObject({
      status: "warning",
      reason: "prefix",
      found: "]d2",
    });
  });

  it("names the Russian layout when the letters came as Cyrillic", () => {
    expect(judgeScan(IN_RUSSIAN, EXPECTED, "keyboard")).toMatchObject({
      status: "problem",
      reason: "layout",
      russianLayout: true,
    });
  });

  it("says where a truncated code stops, and when its beginning is lost", () => {
    expect(judgeScan(EXPECTED.slice(0, 40), EXPECTED, "com")).toMatchObject({
      reason: "truncated",
      position: 40,
    });
    expect(judgeScan(EXPECTED.slice(20), EXPECTED, "com")).toMatchObject({ reason: "headLost" });
  });

  it("notes characters added around a whole code (a carriage return, a suffix)", () => {
    expect(judgeScan(`${EXPECTED}\r`, EXPECTED, "com")).toMatchObject({
      reason: "extra",
      count: 1,
    });
  });

  it("points at the first differing character of a damaged code", () => {
    const damaged = `${EXPECTED.slice(0, 30)}Z${EXPECTED.slice(31)}`;
    expect(judgeScan(damaged, EXPECTED, "com")).toMatchObject({
      reason: "different",
      position: 31,
      count: 1,
      foundChar: "Z",
    });
  });

  it("calls a scan that is not the shown code foreign (a bare GTIN here), and shows it masked only", () => {
    const verdict = judgeScan("4600682000013", EXPECTED, "keyboard");
    expect(verdict).toMatchObject({ status: "problem", reason: "foreign", type: "gtin" });
    expect(verdict.masked).toBe("4600•••••••13");
    expect(verdict.masked).not.toContain("00682");
  });

  it("calls a too-short scan foreign or truncated, never OK", () => {
    expect(judgeScan("0", EXPECTED, "keyboard").status).toBe("problem");
    expect(judgeScan("01", EXPECTED, "keyboard").reason).toBe("truncated");
  });

  it("reads an SSCC scan by its 00 prefix as a pallet, not as the test code", () => {
    const verdict = judgeScan("00346006820000000014", EXPECTED, "keyboard");
    expect(verdict).toMatchObject({ status: "problem", reason: "foreign", type: "sscc" });
  });

  it("blames a COM port's speed for bytes that were not text", () => {
    expect(judgeScan("��x�", EXPECTED, "com")).toMatchObject({
      status: "problem",
      reason: "unreadable",
    });
  });

  it("tells a wrong GTIN check digit of a code that starts like a marking code", () => {
    const verdict = judgeScan(`01${TEST_GTIN.slice(0, 13)}0${GS}21AB`, EXPECTED, "keyboard");
    expect(verdict.structure).toEqual([{ ai: "01", length: 14, checkDigitValid: false }]);
  });
});

describe("judgeScan on a plain code", () => {
  const plain = "MKR-7Q4F2N";
  it("matches exactly and finds an AIM prefix, a layout and a cut", () => {
    expect(judgeScan(plain, plain, "keyboard")).toMatchObject({ status: "ok", type: "unknown" });
    expect(judgeScan(`]C0${plain}`, plain, "com")).toMatchObject({
      reason: "prefix",
      found: "]C0",
    });
    expect(judgeScan("MKR-7Q4F", plain, "com")).toMatchObject({ reason: "truncated" });
    expect(judgeScan("ЬЛК-7Й4А2Т", plain, "keyboard").russianLayout).toBe(true);
  });
});

describe("what the screen shows of a scan", () => {
  it("draws the separator visibly and other controls in hex", () => {
    expect(visible(`a${GS}b\u0004`)).toBe(`a${GS_MARK}b<04>`);
  });

  it("masks all but the first and last characters, keeping every separator", () => {
    const masked = maskScan(EXPECTED);
    expect(masked.startsWith("0102")).toBe(true);
    expect(masked.split(GS_MARK)).toHaveLength(3);
    expect(masked).not.toContain("TEST");
    expect(masked.endsWith("•9D".slice(1))).toBe(true);
  });

  it("keeps the last five results only", () => {
    const entry = (n: number): SelfTestEntry => ({
      at: `00:00:0${n}`,
      kind: "dm",
      verdict: judgeScan(EXPECTED, EXPECTED, "keyboard"),
    });
    let history: SelfTestEntry[] = [];
    for (let n = 0; n < 8; n++) history = pushHistory(history, entry(n));
    expect(history).toHaveLength(HISTORY_SIZE);
    expect(history[0]?.at).toBe("00:00:07");
  });
});
