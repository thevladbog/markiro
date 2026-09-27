import { randomUUID } from "node:crypto";
import { buildSscc } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  caseLinkCommandSchema,
  caseUnlinkCommandSchema,
  caseListQuerySchema,
  caseLookupQuerySchema,
} from "../src/traceability/case-bridge.js";

const code = buildSscc(0, "1234567", 7);

describe("US case bridge contract", () => {
  it("normalizes scanner wrappers and rejects canonical duplicates", () => {
    expect(
      caseLinkCommandSchema.parse({ operationKey: randomUUID(), ssccs: [`]C1(00)${code}`] }).ssccs,
    ).toEqual([code]);
    expect(
      caseLinkCommandSchema.safeParse({ operationKey: randomUUID(), ssccs: [code, `(00)${code}`] })
        .success,
    ).toBe(false);
  });

  it("rejects bad checksums, oversized batches, unknown keys and invalid operation keys", () => {
    const wrong = code.at(-1) === "0" ? "1" : "0";
    for (const input of [
      { operationKey: randomUUID(), ssccs: [`${code.slice(0, -1)}${wrong}`] },
      { operationKey: randomUUID(), ssccs: Array(101).fill(code) },
      { operationKey: randomUUID(), ssccs: [code], extra: true },
      { operationKey: "not-a-uuid", ssccs: [code] },
    ])
      expect(caseLinkCommandSchema.safeParse(input).success).toBe(false);
  });

  it("trims a bounded unlink reason", () => {
    expect(
      caseUnlinkCommandSchema.parse({ operationKey: randomUUID(), reason: "  Wrong lot  " }).reason,
    ).toBe("Wrong lot");
    for (const reason of [" a ", "x".repeat(2001)]) {
      expect(
        caseUnlinkCommandSchema.safeParse({ operationKey: randomUUID(), reason }).success,
      ).toBe(false);
    }
  });

  it("bounds list queries and normalizes lookup SSCC", () => {
    expect(caseListQuerySchema.parse({})).toMatchObject({ limit: 50, history: false });
    expect(caseListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(caseListQuerySchema.safeParse({ cursor: "garbage" }).success).toBe(false);
    expect(caseLookupQuerySchema.parse({ sscc: `(00)${code}` }).sscc).toBe(code);
  });
});
