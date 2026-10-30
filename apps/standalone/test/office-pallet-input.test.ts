import { describe, expect, it } from "vitest";
import { parsePalletFile, inspectPalletInput } from "../src/office/codes/pallet-input.js";

const BOX = "046006820000015000";
describe("office pallet code input", () => {
  it("reads UTF-8 BOM, Windows lines and one quoted CSV column without losing zeros", () => {
    expect(
      parsePalletFile(
        "boxes.csv",
        new TextEncoder().encode(`\ufeff"${BOX}"\r\n\r\n"00${BOX}"\r\n`),
      ),
    ).toEqual([BOX, "", `00${BOX}`, ""]);
  });
  it.each([`"${BOX}",other`, `"${BOX}`, `${BOX}"`, `code;other`])(
    "refuses malformed CSV %s",
    (text) => {
      expect(() => parsePalletFile("boxes.csv", new TextEncoder().encode(text))).toThrow();
    },
  );
  it("refuses other extensions, invalid UTF-8 and oversized files", () => {
    expect(() => parsePalletFile("boxes.xlsx", new Uint8Array())).toThrow();
    expect(() => parsePalletFile("boxes.txt", new Uint8Array([0xff]))).toThrow();
    expect(() => parsePalletFile("boxes.txt", new Uint8Array(1_048_577))).toThrow();
  });
  it("normalizes via domain rules and points to every duplicate's original line", () => {
    const result = inspectPalletInput(`${BOX}\n\n00${BOX}\n(00)${BOX}`);
    expect(result.errors.map((error) => [error.line, error.code, error.sscc])).toEqual([
      [1, "duplicate", BOX],
      [3, "duplicate", BOX],
      [4, "duplicate", BOX],
    ]);
  });
  it("reports invalid values and refuses more than 1000 nonempty codes", () => {
    expect(inspectPalletInput("broken").errors[0]?.code).toBe("invalid_sscc");
    expect(inspectPalletInput(Array(1001).fill(BOX).join("\n")).limitExceeded).toBe(true);
    expect(inspectPalletInput(Array(1000).fill(BOX).join("\n")).limitExceeded).toBe(false);
  });
});
