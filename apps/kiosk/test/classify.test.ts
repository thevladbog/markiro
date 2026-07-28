import { describe, expect, it } from "vitest";
import { buildSscc } from "@markiro/domain";
import { classifyKioskScan } from "../src/domain-guard/classify.js";

const GS = String.fromCharCode(0x1d);
const GTIN = "04600682000013";
const SSCC = buildSscc(1, "123456", 12345);

describe("classifyKioskScan", () => {
  it("recognises a well-formed marking code and exposes its dedup key", () => {
    const scan = classifyKioskScan(`01${GTIN}21KYC9X7MQ${GS}93Abcd`);
    expect(scan).toMatchObject({ kind: "km", gtin14: GTIN });
    if (scan.kind === "km") expect(scan.kmKey).toBe(`01${GTIN}21KYC9X7MQ`);
  });

  it("reports a marking code whose GS separator was dropped as incomplete, not as a badge", () => {
    // A keyboard wedge that swallows the separator produces exactly this.
    expect(classifyKioskScan(`01${GTIN}21KYC9X7MQ93Abcd`).kind).toBe("incomplete");
  });

  it("treats a badge payload as a badge", () => {
    expect(classifyKioskScan("MARKIRO-BADGE-4412")).toMatchObject({ kind: "badge" });
  });

  it("never classifies an empty scan", () => {
    expect(classifyKioskScan("").kind).toBe("unknown");
  });

  it("classifies a bare GTIN as unknown, not badge", () => {
    expect(classifyKioskScan(GTIN).kind).toBe("unknown");
  });

  it("classifies an SSCC as unknown, not badge", () => {
    expect(classifyKioskScan(SSCC).kind).toBe("unknown");
  });

  it("still classifies an opaque badge payload as badge", () => {
    expect(classifyKioskScan("OPAQUE-BADGE-PAYLOAD").kind).toBe("badge");
  });
});
