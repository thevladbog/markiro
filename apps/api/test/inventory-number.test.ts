import { describe, expect, it } from "vitest";
import { formatInventoryNumber } from "../src/modules/inventories/inventory-number";

describe("formatInventoryNumber", () => {
  it("formats INVENTORY-YY-NNNN for new inventory documents", () => {
    expect(formatInventoryNumber(7, new Date("2026-08-20T00:00:00Z"))).toBe("INVENTORY-26-0007");
  });

  it("does not truncate large seqs", () => {
    expect(formatInventoryNumber(12345, new Date("2026-08-20T00:00:00Z"))).toBe(
      "INVENTORY-26-12345",
    );
  });

  it("keeps the year at two digits across the century mark", () => {
    expect(formatInventoryNumber(1, new Date("2100-01-01T00:00:00Z"))).toBe("INVENTORY-00-0001");
  });

  it("never collides with the billing invoice format", () => {
    // Billing invoices are `MRK-INV-NNNNNN`; inventories must stay distinguishable.
    expect(formatInventoryNumber(21, new Date("2026-01-01T00:00:00Z"))).not.toMatch(
      /^MRK-INV-\d{6}$/,
    );
  });
});
