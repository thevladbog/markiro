import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { deviceGrantSchema, grantOwnerSchema } from "../src/offline-grants.js";
import {
  deviceGrantRequestSchema,
  taskGrantRequestSchema,
  grantTaskSnapshotSchema,
  grantKeysetSchema,
  offlineGrantSchema,
  taskGrantSchema,
  grantProtectedHeaderSchema,
  grantEnvelopeSchema,
  grantIssueResultSchema,
  grantConfigurationSchema,
  type DeviceGrant,
  type TaskGrant,
  type GrantOwner,
  type GrantEnvelope,
} from "../src/offline-grants.js";

const owner = {
  tenantId: "fixture-tenant",
  deviceId: "fixture-device",
  kind: "station",
  credentialEpoch: 1,
} as const;
const base = {
  ...owner,
  version: 1,
  issuer: "https://fixture.invalid",
  grantId: "fixture-grant",
  entitlementRevision: "r1",
  policyRevision: "p1",
  issuedAt: 1000,
  notBefore: 1000,
} as const;
const device = {
  ...base,
  kindOfGrant: "device",
  startNotAfter: 2000,
  capabilities: ["shift.start.v1"],
} as const;
const task = {
  ...base,
  kindOfGrant: "task",
  taskKind: "shift",
  taskId: "fixture-task",
  snapshotDigest: "fixture-digest",
  completeNotAfter: 2000,
  eventTypes: ["shift.scan.v1"],
  budget: [{ id: "units", unit: "unit", maximum: 10 }],
} as const;

describe("offline grants v1", () => {
  it("requires explicit negotiation and identity-only task input", () => {
    const request = {
      protocol: "offline-grants-v1",
      capability: "offline-grants-v1",
      requestId: "018f7bd1-4420-4b13-9f77-89f3a5374763",
    };
    expect(deviceGrantRequestSchema.parse(request)).toEqual(request);
    const taskRequest = { ...request, taskKind: "shift", taskId: request.requestId };
    expect(taskGrantRequestSchema.parse(taskRequest)).toEqual(taskRequest);
    for (const patch of [
      { protocol: "unknown" },
      { capability: "unknown" },
      { requestId: "local" },
      { origin: "https://other.invalid" },
      { owner },
      { bounds: [] },
      { snapshotDigest: "0".repeat(64) },
    ]) {
      expect(taskGrantRequestSchema.safeParse({ ...taskRequest, ...patch }).success).toBe(false);
    }
    expect(
      grantTaskSnapshotSchema.safeParse({
        taskKind: "shift",
        taskId: request.requestId,
        snapshotDigest: "0".repeat(64),
        canonical: "{}",
      }).success,
    ).toBe(true);
    expect(
      grantTaskSnapshotSchema.safeParse({
        taskKind: "shift",
        taskId: request.requestId,
        snapshotDigest: "invalid",
        canonical: "",
      }).success,
    ).toBe(false);
  });
  it("requires an explicit, unambiguous public keyset and retirement list", () => {
    const key = {
      kid: "one",
      jwk: { kty: "EC", crv: "P-256", x: "a".repeat(43), y: "b".repeat(43) },
    };
    const keyset = {
      protocol: "offline-grants-v1",
      origin: "https://fixture.invalid",
      revision: "r1",
      keys: [key],
      retiredKids: [],
    };
    expect(grantKeysetSchema.parse(keyset)).toEqual(keyset);
    for (const patch of [
      { keys: [key, key] },
      { retiredKids: ["old", "old"] },
      { keys: [] },
      { origin: "https://fixture.invalid/path" },
      { privateKey: "forbidden" },
    ])
      expect(grantKeysetSchema.safeParse({ ...keyset, ...patch }).success).toBe(false);
  });
  it("requires complete grants and supports explicit unconfigured policy denial", () => {
    expect(offlineGrantSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(
      grantIssueResultSchema.parse({ status: "denied", reason: "policy_not_configured" }),
    ).toEqual({ status: "denied", reason: "policy_not_configured" });
  });
  it("keeps structural interfaces aligned with inferred schemas", () => {
    expectTypeOf<z.infer<typeof deviceGrantSchema>>().toEqualTypeOf<DeviceGrant>();
    expectTypeOf<z.infer<typeof taskGrantSchema>>().toEqualTypeOf<TaskGrant>();
    expectTypeOf<z.infer<typeof grantOwnerSchema>>().toEqualTypeOf<GrantOwner>();
    expectTypeOf<z.infer<typeof grantEnvelopeSchema>>().toEqualTypeOf<GrantEnvelope>();
    expect(offlineGrantSchema.parse(device)).toEqual(device);
    expect(offlineGrantSchema.parse(task)).toEqual(task);
  });
  it.each([-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid credential epoch %s",
    (credentialEpoch) => {
      expect(offlineGrantSchema.safeParse({ ...device, credentialEpoch }).success).toBe(false);
    },
  );
  it.each([
    { extra: true },
    { issuedAt: -1 },
    { notBefore: 1.5 },
    { issuedAt: 1001 },
    { notBefore: 2000 },
    { startNotAfter: 1000 },
    { capabilities: [] },
    { capabilities: ["unknown"] },
    { capabilities: ["pickup.start.v1"] },
    { capabilities: ["shift.start.v1", "shift.start.v1"] },
  ])("rejects invalid device payload %j", (patch) => {
    expect(offlineGrantSchema.safeParse({ ...device, ...patch }).success).toBe(false);
  });
  it.each([
    { budget: [] },
    { budget: [...task.budget, ...task.budget] },
    { budget: [{ id: "units", unit: "unit", maximum: -1 }] },
    { budget: [{ id: "units", unit: "unit", maximum: 1.5 }] },
    { budget: [{ id: "units", unit: "unit", maximum: 1, extra: true }] },
    { completeNotAfter: 1000 },
    { kind: "kiosk" },
    { taskKind: "pickup" },
    { eventTypes: [] },
    { eventTypes: ["inventory.scan.v1"] },
  ])("rejects invalid task payload %j", (patch) => {
    expect(offlineGrantSchema.safeParse({ ...task, ...patch }).success).toBe(false);
  });
  it("accepts compatible native task kinds and zero remaining budget", () => {
    expect(offlineGrantSchema.safeParse({ ...task, kind: "handheld" }).success).toBe(true);
    expect(
      offlineGrantSchema.safeParse({
        ...task,
        taskKind: "inventory",
        eventTypes: ["inventory.scan.v1"],
      }).success,
    ).toBe(true);
    expect(
      offlineGrantSchema.safeParse({
        ...task,
        kind: "kiosk",
        taskKind: "pickup",
        eventTypes: ["pickup.complete.v1"],
      }).success,
    ).toBe(true);
    expect(
      taskGrantSchema.safeParse({ ...task, budget: [{ id: "units", unit: "unit", maximum: 0 }] })
        .success,
    ).toBe(true);
  });
  it("strictly pins protected header and transport while preserving compact bytes", () => {
    const header = { typ: "markiro-offline-grant+jws", alg: "ES256", kid: "fixture-key" };
    expect(grantProtectedHeaderSchema.parse(header)).toEqual(header);
    for (const patch of [
      { alg: "none" },
      { alg: "HS256" },
      { typ: "JWT" },
      { kid: "" },
      { crit: ["custom"] },
    ]) {
      expect(grantProtectedHeaderSchema.safeParse({ ...header, ...patch }).success).toBe(false);
    }
    const envelope = {
      protocol: "offline-grants-v1",
      serverTime: 1000,
      owner,
      mode: "observe",
      grants: ["original.compact.bytes"],
      taskSnapshots: [],
    };
    expect(grantEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(grantIssueResultSchema.parse({ status: "issued", envelope })).toEqual({
      status: "issued",
      envelope,
    });
    expect(grantEnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
    expect(grantIssueResultSchema.safeParse({ status: "denied", reason: "unknown" }).success).toBe(
      false,
    );
  });
});

it("carries authenticated recovery configuration independently of productive grants", () => {
  const config = {
    protocol: "offline-grants-v1",
    owner,
    serverTime: 1000,
    mode: "observe",
    policyRevision: null,
    keyset: null,
  };
  expect(grantConfigurationSchema.parse(config)).toEqual(config);
  expect(grantConfigurationSchema.safeParse({ ...config, grants: [] }).success).toBe(false);
  expect(grantConfigurationSchema.safeParse({ ...config, mode: "client_override" }).success).toBe(
    false,
  );
});
