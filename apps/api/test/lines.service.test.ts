import { describe, expect, it, vi } from "vitest";

import type { Db } from "@markiro/db";

import { LinesService } from "../src/modules/lines/lines.service";

describe("LinesService.listPresence", () => {
  it("does not count or report activity from revoked stations", async () => {
    const activeSeenAt = new Date();
    const revokedSeenAt = new Date(activeSeenAt.getTime() + 1_000);
    const rows = [
      {
        lineId: "line-1",
        lineName: "Line 1",
        deviceId: "station-active",
        apiKeyId: "key-active",
        revokedAt: null,
        lastSeenAt: activeSeenAt,
      },
      {
        lineId: "line-1",
        lineName: "Line 1",
        deviceId: "station-revoked",
        apiKeyId: null,
        revokedAt: new Date("2026-08-29T09:00:00.000Z"),
        lastSeenAt: revokedSeenAt,
      },
      {
        lineId: "line-2",
        lineName: "Line 2",
        deviceId: null,
        apiKeyId: null,
        revokedAt: null,
        lastSeenAt: null,
      },
    ];
    const where = vi.fn(async () => rows);
    const leftJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ leftJoin }));
    const db = { select: vi.fn(() => ({ from })) } as unknown as Db;

    const result = await new LinesService(db, {} as never).listPresence("tenant-1");

    expect(result).toEqual({
      items: [
        {
          lineId: "line-1",
          lineName: "Line 1",
          assignedStations: 1,
          onlineStations: 1,
          lastSeenAt: activeSeenAt,
        },
        {
          lineId: "line-2",
          lineName: "Line 2",
          assignedStations: 0,
          onlineStations: 0,
          lastSeenAt: null,
        },
      ],
    });
  });
});
