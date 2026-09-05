import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

describe("TLC field contracts", () => {
  it.each(["=Supplier / Á-01", "+001  a  A", "-001", "@supplier", "e\u0301 / é", "🍎".repeat(120)])(
    "normalizes entry only, preserving opaque content %s",
    (value) => {
      expect(contracts.tlcSchema.parse(`  ${value}  `)).toBe(value);
      expect(contracts.preservedTlcSchema.parse(value)).toBe(value);
    },
  );
  it.each([
    "",
    "   ",
    "A\0B",
    "A\u001dB",
    "\nA",
    "A\t",
    "A\u0085B",
    "A\ud800B",
    "🍎".repeat(121),
    null,
    123,
  ])("rejects invalid input and stored text %j", (value) => {
    expect(contracts.tlcSchema.safeParse(value).success).toBe(false);
    expect(contracts.preservedTlcSchema.safeParse(value).success).toBe(false);
  });
  it("rejects noncanonical stored identity instead of rewriting it during a read", () => {
    expect(contracts.preservedTlcSchema.safeParse(" Supplier-1 ").success).toBe(false);
  });
});

describe("assignment field contracts", () => {
  it.each(["imported", "transformation", "exempt_supplier_receipt"])(
    "accepts P0 basis %s",
    (basis) => {
      expect(contracts.p0TlcAssignmentBasisSchema.parse(basis)).toBe(basis);
      expect(contracts.tlcAssignmentBasisSchema.parse(basis)).toBe(basis);
    },
  );
  it.each(["initial_packing", "first_land_receiving"])(
    "recognizes %s without enabling it in P0",
    (basis) => {
      expect(contracts.tlcAssignmentBasisSchema.parse(basis)).toBe(basis);
      expect(contracts.p0TlcAssignmentBasisSchema.safeParse(basis).success).toBe(false);
    },
  );
  it.each(["Imported", "", "manual", "toString", null])("rejects unknown basis %j", (basis) => {
    expect(contracts.tlcAssignmentBasisSchema.safeParse(basis).success).toBe(false);
    expect(contracts.p0TlcAssignmentBasisSchema.safeParse(basis).success).toBe(false);
  });
});

describe("manual status change contract", () => {
  it.each(["active", "consumed", "shipped", "quarantined", "recalled", "archived"])(
    "accepts status %s and an explicit reason, without inventing metadata",
    (status) => {
      expect(contracts.changeLotStatusSchema.parse({ status, reason: "  QA reviewed  " })).toEqual({
        status,
        reason: "QA reviewed",
      });
    },
  );
  it.each([
    {},
    { status: "recalled" },
    { reason: "QA reviewed" },
    { status: "draft", reason: "Reviewed" },
  ])("rejects incomplete or unknown status %j", (input) => {
    expect(contracts.changeLotStatusSchema.safeParse(input).success).toBe(false);
  });
  it.each(["", "  ab  ", "a".repeat(2001), null, 123])("rejects invalid reason %j", (reason) => {
    expect(contracts.changeLotStatusSchema.safeParse({ status: "recalled", reason }).success).toBe(
      false,
    );
  });
  it.each(["abc", "a".repeat(2000)])("permits a reason at the boundary", (reason) => {
    expect(contracts.changeLotStatusSchema.parse({ status: "recalled", reason }).reason).toBe(
      reason,
    );
  });
  it.each([
    { tenantId: "a0000000-0000-4000-8000-000000000001" },
    { actorId: "forged-qa" },
    { context: "system:shipping_recalculation" },
    { originEventId: "a0000000-0000-4000-8000-000000000002" },
    { from: "quarantined" },
    { unknown: true },
  ])("refuses client-supplied authority or extra fields %j", (extra) => {
    expect(
      contracts.changeLotStatusSchema.safeParse({
        status: "active",
        reason: "QA reviewed",
        ...extra,
      }).success,
    ).toBe(false);
  });
});
