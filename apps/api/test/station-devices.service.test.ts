import { describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";

describe("StationDevicesService lifecycle", () => {
  it("pre-creates an awaiting station without minting or returning an API key", async () => {
    const createdAt = new Date("2026-08-06T09:00:00Z");
    const insertValues = vi.fn().mockReturnValue({
      returning: () =>
        Promise.resolve([
          {
            id: "device-1",
            tenantId: "tenant-1",
            name: "Packing station",
            lineId: null,
            apiKeyId: null,
            enrolledAt: createdAt,
            pairedAt: null,
            revokedAt: null,
            lastSeenAt: null,
          },
        ]),
    });
    const db = {
      insert: () => ({ values: insertValues }),
    } as unknown as Db;
    const service = new StationDevicesService(db);

    expect("create" in service).toBe(true);
    const result = await service.create("tenant-1", { name: "Packing station", lineId: null });

    expect(insertValues).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      name: "Packing station",
      lineId: null,
      apiKeyId: null,
    });
    expect(result).toMatchObject({
      id: "device-1",
      name: "Packing station",
      lineId: null,
      lineName: null,
      lifecycle: "awaiting_pairing",
      createdAt,
    });
    expect(result).not.toHaveProperty("apiKey");
  });

  it("keeps the durable device ID and API-key reference when only its line changes", async () => {
    const updateSet = vi.fn().mockReturnValue({
      where: () => ({
        returning: () =>
          Promise.resolve([
            {
              id: "device-1",
              tenantId: "tenant-1",
              name: "Packing station",
              lineId: "line-2",
              apiKeyId: "key-1",
              enrolledAt: new Date("2026-08-06T09:00:00Z"),
              pairedAt: new Date("2026-08-06T09:02:00Z"),
              revokedAt: null,
              lastSeenAt: null,
            },
          ]),
      }),
    });
    const db = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () =>
              Promise.resolve([
                {
                  device: {
                    id: "device-1",
                    tenantId: "tenant-1",
                    name: "Packing station",
                    lineId: "line-1",
                    apiKeyId: "key-1",
                    enrolledAt: new Date("2026-08-06T09:00:00Z"),
                    pairedAt: new Date("2026-08-06T09:02:00Z"),
                    revokedAt: null,
                    lastSeenAt: null,
                  },
                  lineName: "Old line",
                },
              ]),
          }),
          where: () => Promise.resolve([{ id: "line-2", name: "New line" }]),
        }),
      }),
      update: () => ({ set: updateSet }),
    } as unknown as Db;
    const service = new StationDevicesService(db);

    expect("update" in service).toBe(true);
    const result = await service.update("tenant-1", "device-1", { lineId: "line-2" });

    expect(updateSet).toHaveBeenCalledWith({ lineId: "line-2" });
    expect(result).toMatchObject({
      id: "device-1",
      lineId: "line-2",
      lineName: "New line",
      lifecycle: "offline",
    });
  });

  it("deletes a paired key before transactionally revoking the durable station and retiring codes", async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const updateCalls: unknown[] = [];
    const tx = {
      update: (table: unknown) => {
        updateCalls.push(table);
        return { set: () => ({ where: () => Promise.resolve(undefined) }) };
      },
    };
    const db = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () =>
              Promise.resolve([
                {
                  device: {
                    id: "device-1",
                    tenantId: "tenant-1",
                    name: "Packing station",
                    lineId: null,
                    apiKeyId: "key-1",
                    enrolledAt: new Date("2026-08-06T09:00:00Z"),
                    pairedAt: new Date("2026-08-06T09:02:00Z"),
                    revokedAt: null,
                    lastSeenAt: null,
                  },
                  lineName: null,
                },
              ]),
          }),
        }),
      }),
      delete: (table: unknown) => {
        expect(table).toBe(schema.apikey);
        return { where: deleteWhere };
      },
      transaction: async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx),
    } as unknown as Db;
    const service = new StationDevicesService(db);

    await service.revoke("tenant-1", "device-1");

    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(updateCalls).toEqual([schema.stationDevices, schema.stationPairingCodes]);
  });
});
