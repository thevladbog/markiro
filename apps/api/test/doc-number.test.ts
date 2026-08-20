import { describe, expect, it } from "vitest";
import { formatDocNo } from "../src/modules/disaggregation/doc-number";

describe("formatDocNo", () => {
  it("formats DSG-YY-NNNN", () => {
    expect(formatDocNo(7, new Date("2026-08-20T00:00:00Z"))).toBe("DSG-26-0007");
  });
  it("does not truncate large seqs", () => {
    expect(formatDocNo(12345, new Date("2026-08-20T00:00:00Z"))).toBe("DSG-26-12345");
  });
});
