import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@markiro/db";
import {
  STATION_ONLINE_THRESHOLD_MS,
  stationDeviceLifecycle,
} from "../src/modules/station-devices/dto";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";
import type { EntitlementsService } from "../src/subscriptions/entitlements.service";

const assignmentMocks = vi.hoisted(() => ({
  assertReservationOpen: vi.fn(),
  workingAssignment: vi.fn(),
  transitionWorkingAssignment: vi.fn(),
}));

vi.mock("../src/subscriptions/working-device-assignments", () => assignmentMocks);

const bypassEntitlements = {
  withQuotaSlot: async (
    _tx: unknown,
    _tenantId: string,
    _key: string,
    create: () => Promise<unknown>,
  ) => create(),
  withQuotaLock: async (
    _tx: unknown,
    _tenantId: string,
    _key: string,
    action: () => Promise<unknown>,
  ) => action(),
} as unknown as EntitlementsService;

describe("StationDevicesService lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentMocks.workingAssignment.mockResolvedValue({
      state: "reserved",
      releaseReason: null,
    });
    assignmentMocks.transitionWorkingAssignment.mockResolvedValue(undefined);
  });

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
      transaction: (callback: (tx: Db) => Promise<unknown>) => callback(db as unknown as Db),
    } as unknown as Db;
    const service = new StationDevicesService(db, bypassEntitlements);

    expect("create" in service).toBe(true);
    const result = await service.create("tenant-1", { name: "Packing station", lineId: null });

    expect(insertValues).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      name: "Packing station",
      lineId: null,
      kind: "station",
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
    expect(assignmentMocks.transitionWorkingAssignment).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: "device-1" }),
      undefined,
    );
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
    const current = {
      id: "device-1",
      tenantId: "tenant-1",
      name: "Packing station",
      kind: "station",
      lineId: "line-1",
      apiKeyId: "key-1",
      enrolledAt: new Date("2026-08-06T09:00:00Z"),
      pairedAt: new Date("2026-08-06T09:02:00Z"),
      revokedAt: null,
      lastSeenAt: null,
    };
    const forUpdate = vi.fn().mockResolvedValue([current]);
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            table === schema.lines
              ? Promise.resolve([{ id: "line-2", name: "New line" }])
              : { for: forUpdate },
        }),
      }),
      update: () => ({ set: updateSet }),
    };
    const db = {
      select: () => ({
        from: () => ({ where: () => Promise.resolve([{ id: "line-2", name: "New line" }]) }),
      }),
      transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as Db;
    const service = new StationDevicesService(db, bypassEntitlements);

    expect("update" in service).toBe(true);
    const result = await service.update("tenant-1", "device-1", { lineId: "line-2" });

    expect(updateSet).toHaveBeenCalledWith({ lineId: "line-2" });
    expect(forUpdate).toHaveBeenCalledWith("update");
    expect(assignmentMocks.workingAssignment).toHaveBeenCalledWith(tx, "tenant-1", "device-1");
    expect(assignmentMocks.transitionWorkingAssignment).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: "device-1", lineId: "line-2" }),
      undefined,
      "observed",
    );
    expect(result).toMatchObject({
      id: "device-1",
      lineId: "line-2",
      lineName: "New line",
      lifecycle: "offline",
    });
  });

  it("deletes a paired key before transactionally revoking the durable station and retiring codes", async () => {
    const order: string[] = [];
    const deleteWhere = vi.fn().mockImplementation(async () => {
      order.push("delete-key");
    });
    const updateCalls: unknown[] = [];
    const lockedDevice = {
      id: "device-1",
      tenantId: "tenant-1",
      apiKeyId: "key-1",
      revokedAt: null,
    };
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve([lockedDevice]) }) }),
      }),
      update: (table: unknown) => {
        updateCalls.push(table);
        return {
          set: () => ({
            where: () => ({ returning: () => Promise.resolve([{ id: "device-1" }]) }),
          }),
        };
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
      transaction: async (callback: (transaction: typeof tx) => Promise<void>) => {
        order.push("transaction");
        return callback(tx);
      },
    } as unknown as Db;
    const service = new StationDevicesService(db, bypassEntitlements);

    await service.revoke("tenant-1", "device-1");

    expect(deleteWhere).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["delete-key", "transaction"]);
    expect(updateCalls).toEqual([schema.stationDevices, schema.stationPairingCodes]);
    expect(assignmentMocks.transitionWorkingAssignment).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: "device-1" }),
      undefined,
    );
  });

  it("does not overwrite the first revocation timestamp when another revoke wins the durable row", async () => {
    const updateCalls: unknown[] = [];
    const lockedDevice = {
      id: "device-1",
      tenantId: "tenant-1",
      apiKeyId: "key-1",
      revokedAt: null,
    };
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ for: () => Promise.resolve([lockedDevice]) }) }),
      }),
      update: (table: unknown) => {
        updateCalls.push(table);
        return {
          set: () => ({
            where: () => ({ returning: () => Promise.resolve([]) }),
          }),
        };
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
      delete: () => ({ where: () => Promise.resolve(undefined) }),
      transaction: async (callback: (transaction: typeof tx) => Promise<void>) => callback(tx),
    } as unknown as Db;

    await new StationDevicesService(db, bypassEntitlements).revoke("tenant-1", "device-1");

    expect(updateCalls).toEqual([schema.stationDevices]);
  });

  it("stores the requested kind on create and defaults to station", async () => {
    const insertValues = vi.fn().mockImplementation((values: { kind: string }) => ({
      returning: () =>
        Promise.resolve([
          {
            id: "device-2",
            tenantId: "tenant-1",
            name: "TSD 1",
            kind: values.kind,
            lineId: null,
            apiKeyId: null,
            enrolledAt: new Date("2026-09-10T09:00:00Z"),
            pairedAt: null,
            revokedAt: null,
            lastSeenAt: null,
          },
        ]),
    }));
    const db = {
      insert: () => ({ values: insertValues }),
      transaction: (callback: (tx: Db) => Promise<unknown>) => callback(db as unknown as Db),
    } as unknown as Db;
    const service = new StationDevicesService(db, bypassEntitlements);

    const handheld = await service.create("tenant-1", {
      name: "TSD 1",
      lineId: null,
      kind: "handheld",
    });
    expect(handheld.kind).toBe("handheld");
    expect(insertValues).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", kind: "handheld" }),
    );
  });

  it("refuses to change the kind of a paired device", async () => {
    const paired = {
      device: {
        id: "device-3",
        tenantId: "tenant-1",
        name: "Paired",
        kind: "station",
        lineId: null,
        apiKeyId: "key-1",
        enrolledAt: new Date("2026-09-10T09:00:00Z"),
        pairedAt: new Date("2026-09-10T09:05:00Z"),
        revokedAt: null,
        lastSeenAt: null,
      },
      lineName: null,
    };
    const forUpdate = vi.fn().mockResolvedValue([paired.device]);
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: forUpdate }) }) }),
    };
    const db = {
      transaction: (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    } as unknown as Db;
    const service = new StationDevicesService(db, bypassEntitlements);

    await expect(
      service.update("tenant-1", "device-3", { kind: "handheld" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(forUpdate).toHaveBeenCalledWith("update");
  });
});

describe("stationDeviceLifecycle", () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const paired = { apiKeyId: "key-1", revokedAt: null };

  it("is online exactly through the threshold and offline immediately after it", () => {
    expect(
      stationDeviceLifecycle(
        { ...paired, lastSeenAt: new Date(now.getTime() - STATION_ONLINE_THRESHOLD_MS) },
        now,
      ),
    ).toBe("online");
    expect(
      stationDeviceLifecycle(
        { ...paired, lastSeenAt: new Date(now.getTime() - STATION_ONLINE_THRESHOLD_MS - 1) },
        now,
      ),
    ).toBe("offline");
  });

  it("treats a future heartbeat as offline instead of online", () => {
    expect(
      stationDeviceLifecycle({ ...paired, lastSeenAt: new Date(now.getTime() + 1) }, now),
    ).toBe("offline");
  });
});
