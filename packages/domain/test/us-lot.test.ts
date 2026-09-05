import { describe, expect, it } from "vitest";
import * as domain from "../src/index.js";

describe("opaque traceability lot codes", () => {
  it.each([
    ["  =Supplier / Á-01  ", "=Supplier / Á-01"],
    ["+001  a  A", "+001  a  A"],
    ["-001", "-001"],
    ["@supplier", "@supplier"],
    ["(01)04006381333931(10)abc", "(01)04006381333931(10)abc"],
    ["e\u0301 / é", "e\u0301 / é"],
    ["箱".repeat(120), "箱".repeat(120)],
    ["🍎".repeat(120), "🍎".repeat(120)],
  ])("preserves identity when entering %s", (raw, expected) => {
    expect(domain.normalizeTlc(raw)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "a".repeat(121),
    "🍎".repeat(121),
    "\nSupplier-01",
    "Supplier-01\t",
    "A\u001dB",
    "A\0B",
    "A\u007fB",
    "A\u0085B",
    "A\ud800B",
    "A\udfffB",
  ])("rejects invalid text without silently repairing it: %j", (raw) => {
    expect(() => domain.normalizeTlc(raw)).toThrow(
      expect.objectContaining({ code: "TLC_INVALID" }),
    );
  });

  it("formats a synthetic civil date without a clock, timezone or locale", () => {
    expect(domain.formatDemoTlc({ prefix: "NRF", date: "2026-09-15", suffix: "APL01" })).toBe(
      "NRF-260915-APL01",
    );
    expect(domain.formatDemoTlc({ prefix: "A1", date: "2028-02-29", suffix: "01" })).toBe(
      "A1-280229-01",
    );
  });

  it.each([
    { date: "2026-02-29" },
    { date: "2026-04-31" },
    { date: "2026-00-01" },
    { date: "0000-01-01" },
    { date: "2026-9-15" },
    { date: "2026-09-15T00:00:00Z" },
    { prefix: "" },
    { prefix: "A\n" },
    { prefix: "a" },
    { prefix: "A".repeat(13) },
    { suffix: "A B" },
    { suffix: "A".repeat(25) },
  ])("rejects invalid demo components %j", (patch) => {
    expect(() =>
      domain.formatDemoTlc({ prefix: "NRF", date: "2026-09-15", suffix: "APL01", ...patch }),
    ).toThrow(expect.objectContaining({ code: "DEMO_TLC_INVALID" }));
  });
});

describe("TLC assignment operation boundary", () => {
  it.each([
    ["imported", "manual"],
    ["imported", "receiving"],
    ["exempt_supplier_receipt", "receiving"],
    ["transformation", "transformation"],
  ])("permits %s in %s", (basis, context) => {
    expect(() => domain.assertLotAssignmentBasis(basis, context)).not.toThrow();
  });

  it.each([
    ["transformation", "manual"],
    ["exempt_supplier_receipt", "manual"],
    ["transformation", "receiving"],
    ["imported", "transformation"],
    ["exempt_supplier_receipt", "transformation"],
  ])("blocks an assignment bypass: %s in %s", (basis, context) => {
    expect(() => domain.assertLotAssignmentBasis(basis, context)).toThrow(
      expect.objectContaining({ code: "ASSIGNMENT_BASIS_NOT_ALLOWED" }),
    );
  });

  it.each(["initial_packing", "first_land_receiving"])("keeps %s reserved", (basis) => {
    expect(() => domain.assertLotAssignmentBasis(basis, "manual")).toThrow(
      expect.objectContaining({ code: "ASSIGNMENT_BASIS_RESERVED" }),
    );
  });
  it.each(["Imported", "", "toString", "__proto__", null, undefined, 1])(
    "rejects an unknown assignment %j",
    (basis) => {
      expect(() => domain.assertLotAssignmentBasis(basis, "manual")).toThrow(
        expect.objectContaining({ code: "ASSIGNMENT_BASIS_INVALID" }),
      );
    },
  );
  it.each(["system", "toString", "__proto__", "", null, undefined])(
    "never falls back for an unknown operation %j",
    (context) => {
      expect(() => domain.assertLotAssignmentBasis("imported", context)).toThrow(
        expect.objectContaining({ code: "ASSIGNMENT_CONTEXT_INVALID" }),
      );
    },
  );
});

describe("manual lot status transitions", () => {
  const transitions: Readonly<Record<string, readonly string[]>> = {
    active: ["consumed", "shipped", "quarantined", "recalled", "archived"],
    quarantined: ["active", "recalled", "archived"],
    consumed: ["recalled", "archived"],
    shipped: ["recalled", "archived"],
    recalled: ["archived"],
    archived: [],
  };
  for (const [from, allowed] of Object.entries(transitions)) {
    for (const to of Object.keys(transitions)) {
      it(`${allowed.includes(to) ? "permits" : "rejects"} ${from} → ${to}`, () => {
        const action = () => domain.assertLotTransition(from, to);
        if (allowed.includes(to)) expect(action).not.toThrow();
        else
          expect(action).toThrow(expect.objectContaining({ code: "LOT_TRANSITION_NOT_ALLOWED" }));
      });
    }
  }
  it.each(["draft", "ACTIVE", "toString", "__proto__", null, undefined, 0])(
    "fails closed for unknown status %j in either position",
    (status) => {
      expect(() => domain.assertLotTransition(status, "active")).toThrow(
        expect.objectContaining({ code: "LOT_STATUS_INVALID" }),
      );
      expect(() => domain.assertLotTransition("active", status)).toThrow(
        expect.objectContaining({ code: "LOT_STATUS_INVALID" }),
      );
    },
  );
});
