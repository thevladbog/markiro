import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const assignmentId = "33333333-3333-4333-8333-333333333333";
const releasedAt = "2026-09-12T09:30:00.000Z";

const reservedDevice = {
  deviceId,
  name: "Линия 1",
  kind: "station",
  assignmentId,
  revision: 2,
  state: "reserved",
  releaseReason: null,
  slotOccupied: true,
  canCancel: true,
  blockedReason: null,
  connectionStatus: "awaiting_pairing",
  pairedAt: null,
  lastSeenAt: null,
} as const;

describe("working-device licensing contracts", () => {
  it("accepts strict cancellation input and rejects client authority", () => {
    const input = { requestId, expectedRevision: 2 };
    expect(contracts.cancelDeviceReservationSchema.parse(input)).toEqual(input);

    for (const invalid of [
      { ...input, requestId: "request" },
      { ...input, expectedRevision: 0 },
      { ...input, expectedRevision: 1.5 },
      { ...input, actorId: "operator" },
      { ...input, tenantId: "tenant-a" },
      { ...input, force: true },
    ]) {
      expect(contracts.cancelDeviceReservationSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts released receipts and rejects incomplete or secret-bearing responses", () => {
    const receipt = {
      requestId,
      deviceId,
      assignmentId,
      revision: 3,
      state: "released",
      releaseReason: "reservation_cancelled",
      releasedAt,
    } as const;
    expect(contracts.deviceReservationReceiptSchema.parse(receipt)).toEqual(receipt);

    for (const invalid of [
      { ...receipt, assignmentId: null },
      { ...receipt, revision: 0 },
      { ...receipt, state: "reserved" },
      { ...receipt, releaseReason: "security_revoked" },
      { ...receipt, releasedAt: null },
      { ...receipt, pairingCode: "12345678" },
      { ...receipt, apiKey: "secret" },
      { ...receipt, internalReason: "quota_repair" },
    ]) {
      expect(contracts.deviceReservationReceiptSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts ready, cancelled, inconsistent and unlimited pool projections", () => {
    const pool = {
      tenantId: "public-pool",
      usage: 1,
      limit: null,
      canCancelReservations: true,
      integrity: "ready",
      devices: [
        reservedDevice,
        {
          ...reservedDevice,
          deviceId: "44444444-4444-4444-8444-444444444444",
          assignmentId: "55555555-5555-4555-8555-555555555555",
          revision: 4,
          state: "released",
          releaseReason: "reservation_cancelled",
          slotOccupied: false,
          canCancel: false,
          blockedReason: "released",
        },
        {
          ...reservedDevice,
          deviceId: "66666666-6666-4666-8666-666666666666",
          assignmentId: null,
          revision: null,
          state: "inconsistent",
          slotOccupied: true,
          canCancel: false,
          blockedReason: "inconsistent",
        },
      ],
    } as const;
    expect(contracts.workingDevicePoolSchema.parse(pool)).toEqual(pool);
    expect(
      contracts.workingDevicePoolSchema.safeParse({
        ...pool,
        integrity: "inconsistent",
        canCancelReservations: false,
      }).success,
    ).toBe(true);
  });

  it("rejects invalid IDs, revisions, device kinds and incomplete released assignments", () => {
    const pool = {
      tenantId: "tenant-a",
      usage: 1,
      limit: 2,
      canCancelReservations: true,
      integrity: "ready",
      devices: [reservedDevice],
    } as const;

    for (const device of [
      { ...reservedDevice, deviceId: "device" },
      { ...reservedDevice, assignmentId: "assignment" },
      { ...reservedDevice, revision: 0 },
      { ...reservedDevice, kind: "kiosk" },
      { ...reservedDevice, state: "released", releaseReason: null },
      { ...reservedDevice, state: "released", assignmentId: null },
      { ...reservedDevice, credential: "secret" },
      { ...reservedDevice, internalReason: "migration_gap" },
    ]) {
      expect(
        contracts.workingDevicePoolSchema.safeParse({ ...pool, devices: [device] }).success,
      ).toBe(false);
    }
    expect(contracts.workingDevicePoolSchema.safeParse({ ...pool, actor: "cabinet" }).success).toBe(
      false,
    );
  });

  it("publishes the frozen cabinet and platform HTTP routes", () => {
    expect(contracts.cabinetDeviceLicensingContracts).toEqual({
      inspect: {
        method: "GET",
        path: "/device-licensing",
        response: contracts.workingDevicePoolSchema,
      },
      cancelReservation: {
        method: "POST",
        path: "/device-licensing/:deviceId/cancel-reservation",
        body: contracts.cancelDeviceReservationSchema,
        response: contracts.deviceReservationReceiptSchema,
      },
    });
    expect(contracts.platformDeviceLicensingContracts).toEqual({
      inspect: {
        method: "GET",
        path: "/platform/tenants/:tenantId/device-licensing",
        response: contracts.workingDevicePoolSchema,
      },
      cancelReservation: {
        method: "POST",
        path: "/platform/tenants/:tenantId/device-licensing/:deviceId/cancel-reservation",
        body: contracts.cancelDeviceReservationSchema,
        response: contracts.deviceReservationReceiptSchema,
      },
    });
  });
});
