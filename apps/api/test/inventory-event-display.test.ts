import { describe, expect, it } from "vitest";

import { formatInventoryEventCopyIdentity } from "../src/modules/inventories/inventory-event-display";

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
