import { describe, expect, it } from "vitest";

import { INVENTORY_STATUS_CHIP } from "../src/pages/inventory/status.js";

describe("inventory status chips", () => {
  it("gives every status a distinct tone+glyph pair", () => {
    const pairs = Object.values(INVENTORY_STATUS_CHIP).map((c) => `${c.status}:${c.glyph}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("separates closed from ready and keeps running green", () => {
    expect(INVENTORY_STATUS_CHIP.ready.status).toBe("info");
    expect(INVENTORY_STATUS_CHIP.cancelled.status).toBe("error");
    expect(INVENTORY_STATUS_CHIP.closed.status).not.toBe(INVENTORY_STATUS_CHIP.ready.status);
    expect(INVENTORY_STATUS_CHIP.running.status).toBe("ok");
  });
});
