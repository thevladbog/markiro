import { describe, expect, it } from "vitest";

import { deviceLink, LINK_FRESH_MS } from "../src/office/devices/device-link.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const device = (lastSeenAt: string | null, revokedAt: string | null = null) => ({
  lastSeenAt,
  revokedAt,
});

describe("the link state of a device (the host's last hearing, not a live connection)", () => {
  it("is «на связи» when the host heard the device within the fresh window", () => {
    expect(deviceLink(device("2026-10-17T11:57:00Z"), NOW)).toBe("online");
    expect(deviceLink(device(new Date(NOW - LINK_FRESH_MS).toISOString()), NOW)).toBe("online");
  });
  it("is «давно не было» when it was heard, but longer ago", () => {
    expect(deviceLink(device(new Date(NOW - LINK_FRESH_MS - 1000).toISOString()), NOW)).toBe(
      "stale",
    );
    expect(deviceLink(device("2026-09-01T00:00:00Z"), NOW)).toBe("stale");
  });
  it("is «нет связи» for a device never heard and for a revoked one, however recent", () => {
    expect(deviceLink(device(null), NOW)).toBe("none");
    expect(deviceLink(device("2026-10-17T11:59:00Z", "2026-10-17T11:00:00Z"), NOW)).toBe("none");
  });
  it("treats a last-heard time ahead of this PC's clock as fresh, not as an error", () => {
    expect(deviceLink(device("2026-10-17T12:03:00Z"), NOW)).toBe("online");
  });
  it("is «давно не было» for a time that does not parse, never a crash", () => {
    expect(deviceLink(device("not a time"), NOW)).toBe("stale");
  });
});
