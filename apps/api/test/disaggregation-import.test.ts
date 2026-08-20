import { describe, expect, it } from "vitest";
import { parseSsccImport } from "../src/modules/disaggregation/import-parser";

describe("parseSsccImport", () => {
  it("splits on newlines, semicolons and commas; trims; drops empties", () => {
    expect(parseSsccImport("123;456\n789,abc\r\n\n  042  \n")).toEqual([
      "123",
      "456",
      "789",
      "abc",
      "042",
    ]);
  });
  it("keeps duplicates (dedup is the document's job, visible as duplicate lines)", () => {
    expect(parseSsccImport("1\n1")).toEqual(["1", "1"]);
  });
  it("throws over 10000 tokens", () => {
    expect(() => parseSsccImport(Array(10001).fill("1").join("\n"))).toThrow();
  });
});
