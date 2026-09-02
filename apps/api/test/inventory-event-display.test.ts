import { describe, expect, it } from "vitest";

import {
  formatInventoryBoxIdentity,
  formatInventoryEventCopyIdentity,
  formatInventoryEventIdentity,
  formatKmHri,
} from "../src/modules/inventories/inventory-event-display";

describe("inventory event display", () => {
  it("returns canonical item and box identities for copying", () => {
    expect(formatInventoryEventCopyIdentity("item", "]d2010468008990038321SERIAL")).toBe(
      "010468008990038321SERIAL",
    );
    expect(formatInventoryEventCopyIdentity("known_box", "(00)046800899000600163")).toBe(
      "00046800899000600163",
    );
  });

  it("does not expose unvalidated raw evidence as a product code", () => {
    expect(formatInventoryEventCopyIdentity("item", null)).toBeNull();
    expect(formatInventoryEventCopyIdentity("item", "invalid")).toBeNull();
    expect(formatInventoryEventCopyIdentity("old_box", "not-an-sscc")).toBeNull();
  });
});

describe("formatInventoryEventIdentity", () => {
  it("renders an item as a readable GTIN and serial without exposing crypto tails", () => {
    expect(
      formatInventoryEventIdentity(
        "item",
        "010460000000001521FOUND-6\u001d91secret\u001d92signature",
        `item:${"a".repeat(64)}`,
      ),
    ).toBe("(01)04600000000015 (21)FOUND-6");
  });

  it("renders scanned boxes in GS1 human-readable form", () => {
    expect(
      formatInventoryEventIdentity(
        "known_box",
        "]C100346006820000000014",
        "known_box:346006820000000014",
      ),
    ).toBe("(00)346006820000000014");
  });

  it("keeps the stored identity when historical raw evidence is absent or malformed", () => {
    const fallback = `item:${"b".repeat(64)}`;
    expect(formatInventoryEventIdentity("item", null, fallback)).toBe(fallback);
    expect(formatInventoryEventIdentity("item", "not-a-km", fallback)).toBe(fallback);
  });
});

describe("formatKmHri", () => {
  it("renders parts the snapshot already holds, with no raw payload to parse", () => {
    // Discrepancy rows carry `gtin14`/`serial` columns rather than a scan, so
    // they format the same identity without going through `canonicalizeKm`.
    expect(formatKmHri("04600000000015", "PROTECTED-FOUND")).toBe(
      "(01)04600000000015 (21)PROTECTED-FOUND",
    );
  });
});

describe("formatInventoryBoxIdentity", () => {
  it("renders a bare SSCC in GS1 human-readable form", () => {
    expect(formatInventoryBoxIdentity("146000000000000012", "new_box:146000000000000012")).toBe(
      "(00)146000000000000012",
    );
  });

  it("keeps the stored identity rather than throwing on an unusable SSCC", () => {
    // A discrepancy list must not 500 on one malformed row.
    expect(formatInventoryBoxIdentity("146000000000000011", "new_box:bad")).toBe("new_box:bad");
    expect(formatInventoryBoxIdentity("", "new_box:bad")).toBe("new_box:bad");
  });
});
