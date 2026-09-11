import { describe, expect, it } from "vitest";
import {
  stationRecoveryIdentitySchema,
  stationRecoveryRequestSchema,
  stationRecoveryResponseSchema,
} from "../src/index.js";

const expected = {
  tenantId: "existing-tenant-id",
  deviceId: "9cdc584c-5fd4-4fa4-a206-a390cad26ef5",
  kind: "station",
};
const request = { version: 1, code: "12345678", expected };
const response = {
  version: 1,
  device: {
    id: expected.deviceId,
    tenantId: expected.tenantId,
    kind: "station",
    name: "Line station",
    organizationName: "Factory",
    line: null,
  },
  credential: { apiKey: "test-key", serverUrl: "https://api.example.test" },
  operators: [
    {
      operatorId: "operator-id",
      name: "Operator",
      login: "4001",
      role: "operator",
      pinHash: "offline-verifier",
      badgeHash: null,
      active: true,
    },
  ],
};

describe("station recovery v1 contracts", () => {
  it("preserves the existing opaque tenant identifier and exact request", () => {
    expect(stationRecoveryRequestSchema.parse(request)).toEqual(request);
    expect(stationRecoveryIdentitySchema.parse(expected)).toEqual(expected);
  });
  it.each([
    { ...request, version: 2 },
    { ...request, version: undefined },
    { ...request, code: "123" },
    { ...request, extra: true },
    { ...request, expected: { ...expected, extra: true } },
    ...[{ tenantId: "" }, { deviceId: "bad-id" }, { kind: "kiosk" }].map((patch) => ({
      ...request,
      expected: { ...expected, ...patch },
    })),
  ])("rejects malformed or extended requests %#", (value) => {
    expect(stationRecoveryRequestSchema.safeParse(value).success).toBe(false);
  });
  it("preserves existing device, credential, offline operator and optional subscription meanings", () => {
    expect(stationRecoveryResponseSchema.parse(response)).toEqual(response);
    for (const status of [
      "unmanaged",
      "pending_activation",
      "trial",
      "active",
      "expired",
      "read_only",
    ]) {
      const value = {
        ...response,
        subscription: { access: "managed", status, startsAt: null, endsAt: null },
      };
      expect(stationRecoveryResponseSchema.parse(value)).toEqual(value);
    }
    expect(
      stationRecoveryResponseSchema.parse({
        ...response,
        device: {
          ...response.device,
          kind: "handheld",
          line: { id: expected.deviceId, name: "Packing" },
        },
      }).device.kind,
    ).toBe("handheld");
  });
  it.each([
    { ...response, version: 2 },
    { ...response, version: undefined },
    { ...response, extra: true },
    { ...response, device: { ...response.device, extra: true } },
    { ...response, credential: { ...response.credential, extra: true } },
    { ...response, operators: [{ ...response.operators[0], extra: true }] },
    {
      ...response,
      subscription: {
        access: "managed",
        status: "active",
        startsAt: null,
        endsAt: null,
        extra: true,
      },
    },
  ])("rejects incompatible or extended responses %#", (value) => {
    expect(stationRecoveryResponseSchema.safeParse(value).success).toBe(false);
  });
});
