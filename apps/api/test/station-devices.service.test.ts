import { describe, expect, it, vi } from "vitest";
import { schema, type Auth, type Db } from "@markiro/db";
import { StationDevicesService } from "../src/modules/station-devices/station-devices.service";

function fakeAuth(createApiKey: Auth["api"]["createApiKey"]): Auth {
  return { api: { createApiKey } } as unknown as Auth;
}

/**
 * Unit-level (no real Postgres) coverage for the M10 rollback fix:
 * `createApiKey` and the `station_devices` insert are not transactional, so
 * a failed insert must not orphan the just-minted api-key. The e2e suite
 * (`test/station-devices.e2e.test.ts`) still covers the happy path against a
 * real DB; this file isolates the rollback branch with a fake `Db`.
 */
describe("StationDevicesService.enroll rollback (M10)", () => {
  it("deletes the just-minted api-key and rethrows when the station_devices insert throws", async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const deleteTables: unknown[] = [];
    const db = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(new Error("insert failed")),
        }),
      }),
      delete: (table: unknown) => {
        deleteTables.push(table);
        return { where: deleteWhere };
      },
    } as unknown as Db;
    const auth = fakeAuth(async () => ({ id: "key_1", key: "mk_abc", referenceId: "t1" }));
    const service = new StationDevicesService(db, auth);

    await expect(
      service.enroll("t1", "user_1", "Terminal 1", "http://localhost:3000"),
    ).rejects.toThrow("insert failed");

    expect(deleteTables).toEqual([schema.apikey]);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("deletes the just-minted api-key and throws when the insert returns no row", async () => {
    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([]),
        }),
      }),
      delete: () => ({ where: deleteWhere }),
    } as unknown as Db;
    const auth = fakeAuth(async () => ({ id: "key_2", key: "mk_def", referenceId: "t1" }));
    const service = new StationDevicesService(db, auth);

    await expect(
      service.enroll("t1", "user_1", "Terminal 1", "http://localhost:3000"),
    ).rejects.toThrow("Failed to enroll device");
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("does not touch the api-key when enrollment succeeds", async () => {
    const deleteWhere = vi.fn();
    const db = {
      insert: () => ({
        values: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: "d1",
                name: "Terminal 1",
                tenantId: "t1",
                apiKeyId: "key_3",
                enrolledAt: new Date("2026-07-23T00:00:00Z"),
                lastSeenAt: null,
              },
            ]),
        }),
      }),
      delete: () => ({ where: deleteWhere }),
    } as unknown as Db;
    const auth = fakeAuth(async () => ({ id: "key_3", key: "mk_ghi", referenceId: "t1" }));
    const service = new StationDevicesService(db, auth);

    const result = await service.enroll("t1", "user_1", "Terminal 1", "http://localhost:3000");

    expect(result).toMatchObject({
      deviceId: "d1",
      apiKey: "mk_ghi",
      serverUrl: "http://localhost:3000",
    });
    expect(deleteWhere).not.toHaveBeenCalled();
  });

  it("does not swallow the original insert error even when the rollback delete itself fails", async () => {
    const db = {
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(new Error("insert failed")),
        }),
      }),
      delete: () => ({ where: () => Promise.reject(new Error("delete also failed")) }),
    } as unknown as Db;
    const auth = fakeAuth(async () => ({ id: "key_4", key: "mk_jkl", referenceId: "t1" }));
    const service = new StationDevicesService(db, auth);

    await expect(
      service.enroll("t1", "user_1", "Terminal 1", "http://localhost:3000"),
    ).rejects.toThrow("insert failed");
  });
});
