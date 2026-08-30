import { describe, expect, it } from "vitest";

import { formatInventoryEventIdentity } from "../src/modules/inventories/inventory-event-display.js";

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
