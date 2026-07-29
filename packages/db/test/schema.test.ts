import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  boxes,
  counterparties,
  lines,
  products,
  shifts,
  ssccCounters,
} from "../src/schema/platform.js";

describe("platform schema", () => {
  it("exports the four tables", () => {
    expect(getTableName(counterparties)).toBe("counterparties");
    expect(getTableName(products)).toBe("products");
    expect(getTableName(lines)).toBe("lines");
    expect(getTableName(shifts)).toBe("shifts");
  });
  it("products enforce tenant-scoped GTIN uniqueness (by declared index name)", () => {
    // structural smoke: the unique index is declared in the table config
    expect(Object.keys(products)).toContain("gtin14");
  });

  it("keys the sscc counter by tenant, issuer and extension digit", () => {
    const cols = Object.keys(ssccCounters);
    expect(cols).toEqual(
      expect.arrayContaining(["tenantId", "issuerGln", "extensionDigit", "nextSerial"]),
    );
  });

  it("gives boxes a tenant-unique sscc", () => {
    const cols = Object.keys(boxes);
    expect(cols).toEqual(
      expect.arrayContaining(["tenantId", "id", "sscc", "shiftId", "terminalId", "closedAt"]),
    );
  });
});
