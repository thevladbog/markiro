import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@markiro/db";
import { KioskDeviceGuard, type RequestWithKiosk } from "../src/tenancy/kiosk-device.guard";

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
  tenantId?: string;
  kioskId?: string;
}

interface FakeKioskRow {
  id: string;
  tenantId: string;
}

/**
 * Fakes only the two drizzle chains the guard actually calls:
 * `db.select().from(kiosks).where(...)` and
 * `db.update(kiosks).set({lastSeenAt}).where(...)`. `selectResult` stands in
 * for what the where() clause resolves to (empty for an unknown token,
 * `[kioskRow]` for a match); `updateSpy` lets tests assert the last_seen_at
 * update chain was actually invoked (not just declared).
 */
function fakeDb(selectResult: FakeKioskRow[], updateSpy = vi.fn()): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => selectResult,
      }),
    }),
    update: () => ({
      set: (values: unknown) => ({
        where: async (cond: unknown) => updateSpy(values, cond),
      }),
    }),
  } as unknown as Db;
}

function contextFor(req: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("KioskDeviceGuard", () => {
  it("throws UnauthorizedException when the x-kiosk-token header is missing", async () => {
    const updateSpy = vi.fn();
    const guard = new KioskDeviceGuard(fakeDb([], updateSpy));
    const req: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it("throws UnauthorizedException when no kiosk matches the token", async () => {
    const guard = new KioskDeviceGuard(fakeDb([]));
    const req: FakeRequest = { headers: { "x-kiosk-token": "unknown-token" } };

    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("sets req.tenantId/req.kioskId, updates last_seen_at, and returns true on a match", async () => {
    const token = "valid-token";
    const kioskRow: FakeKioskRow = { id: "kiosk_1", tenantId: "tenant_1" };
    const updateSpy = vi.fn();
    const guard = new KioskDeviceGuard(fakeDb([kioskRow], updateSpy));
    const req: FakeRequest = { headers: { "x-kiosk-token": token } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);

    expect((req as RequestWithKiosk).tenantId).toBe("tenant_1");
    expect((req as RequestWithKiosk).kioskId).toBe("kiosk_1");
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0]![0]).toEqual({ lastSeenAt: expect.any(Date) });
  });

  it("takes the first value when x-kiosk-token is sent as multiple header values", async () => {
    const kioskRow: FakeKioskRow = { id: "kiosk_2", tenantId: "tenant_2" };
    const guard = new KioskDeviceGuard(fakeDb([kioskRow]));
    const req: FakeRequest = { headers: { "x-kiosk-token": ["array-token", "second"] } };

    await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    expect((req as RequestWithKiosk).kioskId).toBe("kiosk_2");
  });
});
