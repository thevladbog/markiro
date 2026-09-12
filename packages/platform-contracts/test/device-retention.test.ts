import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const at = "2026-09-12T10:00:00.000Z";
const boundaryAt = "2026-09-12T10:03:00.000Z";
const quota = (limit: number | null) => ({
  limit,
  used: 1,
  remaining: limit === null ? null : Math.max(0, limit - 1),
});
const snapshot = (asOf: string, limit: number | null = 1) => ({
  version: 1,
  tenantId: "tenant-a",
  asOf,
  countedAt: asOf,
  revision: "0",
  usageRevision: "0",
  nextChangeAt: null,
  current: {
    access: "read_only",
    writeAllowed: false,
    subscription: null,
    quotas: {
      lines: quota(limit),
      stations: quota(limit),
      kiosks: quota(limit),
      cabinetUsers: quota(limit),
    },
    features: { labelEditor: false, publicApi: false, pallets: false },
  },
  candidate: {
    quotas: {
      lines: quota(limit),
      stations: quota(limit),
      kiosks: quota(limit),
      cabinetUsers: quota(limit),
    },
    features: {
      labelEditor: null,
      publicApi: null,
      pallets: null,
      chzIntegration: null,
      inventory: null,
      commerceMl: null,
      handheld: true,
    },
  },
  sources: [],
  readiness: { mode: "shadow", reasons: ["lifecycle_policy_not_ready"] },
  historical: { available: false },
  connectivity: { observedAt: asOf, chz: "unknown", nationalCatalog: "unknown" },
});
const device = {
  deviceId: id,
  name: "Линия 1",
  kind: "station",
  assignmentId: otherId,
  revision: 1,
  state: "reserved",
  eligible: true,
  reasons: [],
  knownServerWork: { activeShifts: 0, activeInventories: 1, printJobs: 0, quarantineBatches: 0 },
  localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
};
const observation = {
  boundary: { key: "a".repeat(64), effectiveAt: boundaryAt },
  current: snapshot(at, 2),
  future: snapshot(boundaryAt),
  devices: [device],
  services: [
    {
      id: otherId,
      nameRu: "Поддержка",
      nameEn: "Support",
      quantity: 1,
      unit: "hour",
      status: "ordered",
    },
  ],
  selectionRequired: true,
  execution: { available: false, reasons: ["enforcement_not_enabled"] },
};
const request = {
  requestId: id,
  boundaryKey: observation.boundary.key,
  selectedDeviceIds: [id],
  expectedRevision: 0,
  reason: "Downgrade",
};
const preview = {
  id: otherId,
  requestId: id,
  createdAt: at,
  expiresAt: boundaryAt,
  expectedRevision: 0,
  selectedDeviceIds: [id],
  observation,
};
const selection = {
  id: otherId,
  revision: 1,
  preparedAt: at,
  selectedDeviceIds: [id],
  observation,
};

describe("device retention contracts", () => {
  it("exports the shared strict contracts", () => {
    for (const name of [
      "Boundary",
      "Device",
      "Observation",
      "PreviewRequest",
      "Confirm",
      "Preview",
      "Selection",
      "Receipt",
      "Inspection",
    ]) {
      expect(c).toHaveProperty(`deviceRetention${name}Schema`);
    }
  });
  it("accepts explicit empty selection and rejects duplicates, invalid revisions and client authority", () => {
    expect(c.deviceRetentionPreviewRequestSchema.parse(request)).toEqual(request);
    expect(
      c.deviceRetentionPreviewRequestSchema.safeParse({ ...request, selectedDeviceIds: [] })
        .success,
    ).toBe(true);
    for (const patch of [
      { selectedDeviceIds: [id, id] },
      { selectedDeviceIds: ["device"] },
      { expectedRevision: -1 },
      { expectedRevision: 0.1 },
      { boundaryKey: "boundary" },
      { reason: " " },
      { reason: "x".repeat(1001) },
      { requestId: "request" },
      { tenantId: "tenant-b" },
      { effectiveAt: boundaryAt },
      { force: true },
    ]) {
      expect(
        c.deviceRetentionPreviewRequestSchema.safeParse({ ...request, ...patch }).success,
      ).toBe(false);
    }
    expect(c.deviceRetentionConfirmSchema.parse({ requestId: id, previewId: otherId })).toEqual({
      requestId: id,
      previewId: otherId,
    });
    expect(
      c.deviceRetentionConfirmSchema.safeParse({
        requestId: id,
        previewId: otherId,
        selectedDeviceIds: [],
      }).success,
    ).toBe(false);
  });
  it("accepts diagnostic shadow observations for unavailable, zero and unlimited future capacity", () => {
    for (const limit of [0, null, 1]) {
      const future = snapshot(boundaryAt, limit);
      expect(c.deviceRetentionObservationSchema.safeParse({ ...observation, future }).success).toBe(
        true,
      );
      expect(
        c.deviceRetentionObservationSchema.safeParse({
          ...observation,
          future: {
            ...future,
            candidate: {
              ...future.candidate,
              features: { ...future.candidate.features, handheld: null },
            },
          },
        }).success,
      ).toBe(true);
    }
    expect(c.deviceRetentionObservationSchema.parse(observation)).toEqual(observation);
  });
  it("preserves an existing-valid 100-character service unit in observations and receipts", () => {
    const unit = "u".repeat(100);
    const withLongUnit = {
      ...observation,
      services: observation.services.map((service) => ({ ...service, unit })),
    };
    expect(c.deviceRetentionObservationSchema.parse(withLongUnit)).toEqual(withLongUnit);
    const receipt = { requestId: id, selection: { ...selection, observation: withLongUnit } };
    expect(c.deviceRetentionReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("rejects unknown fields, duplicate devices, fabricated readiness and inconsistent boundary snapshots", () => {
    for (const patch of [
      { boundary: { ...observation.boundary, force: true } },
      { current: { ...observation.current, tenantId: "tenant-b" } },
      { current: snapshot(boundaryAt) },
      { future: snapshot(at) },
      { devices: [device, device] },
      { devices: [{ ...device, revision: 0 }] },
      { devices: [{ ...device, localData: { ...device.localData, outbox: 0 } }] },
      { devices: [{ ...device, knownServerWork: { ...device.knownServerWork, printJobs: -1 } }] },
      { devices: [{ ...device, state: "released" }] },
      { devices: [{ ...device, reasons: ["whatever"] }] },
      { services: [{ ...observation.services[0], status: "invented" }] },
      { services: [{ ...observation.services[0], quantity: 0.5 }] },
      { execution: { available: true, reasons: ["enforcement_not_enabled"] } },
      { execution: { available: false, reasons: [] } },
      {
        execution: {
          available: false,
          reasons: ["enforcement_not_enabled", "enforcement_not_enabled"],
        },
      },
    ])
      expect(
        c.deviceRetentionObservationSchema.safeParse({ ...observation, ...patch }).success,
      ).toBe(false);
  });
  it("bounds previews to five minutes and the observed boundary and validates selection membership", () => {
    expect(c.deviceRetentionPreviewSchema.parse(preview)).toEqual(preview);
    for (const patch of [
      { expiresAt: at },
      { expiresAt: "2026-09-12T10:04:00.000Z" },
      { createdAt: "2026-09-12T09:57:00.000Z" },
      { selectedDeviceIds: [otherId] },
      { selectedDeviceIds: [id, id] },
      { expectedRevision: -1 },
      {
        observation: {
          ...observation,
          devices: [{ ...device, eligible: false, reasons: ["device_inconsistent"] }],
        },
      },
      { observation: { ...observation, future: snapshot(boundaryAt, 0) } },
      ...[false, null].map((handheld) => ({
        observation: {
          ...observation,
          devices: [{ ...device, kind: "handheld" }],
          future: {
            ...observation.future,
            candidate: {
              ...observation.future.candidate,
              features: { ...observation.future.candidate.features, handheld },
            },
          },
        },
      })),
    ])
      expect(c.deviceRetentionPreviewSchema.safeParse({ ...preview, ...patch }).success).toBe(
        false,
      );
    for (const limit of [0, null]) {
      expect(
        c.deviceRetentionPreviewSchema.safeParse({
          ...preview,
          selectedDeviceIds: [],
          observation: { ...observation, future: snapshot(boundaryAt, limit) },
        }).success,
      ).toBe(true);
    }
  });
  it("preserves historical selections with positive revision and coherent preparation time", () => {
    expect(c.deviceRetentionSelectionSchema.parse(selection)).toEqual(selection);
    for (const patch of [
      { revision: 0 },
      { preparedAt: boundaryAt },
      { preparedAt: "2026-09-12T09:59:00.000Z" },
      { selectedDeviceIds: [otherId] },
    ]) {
      expect(c.deviceRetentionSelectionSchema.safeParse({ ...selection, ...patch }).success).toBe(
        false,
      );
    }
    expect(c.deviceRetentionReceiptSchema.parse({ requestId: id, selection })).toEqual({
      requestId: id,
      selection,
    });
    const inspection = {
      canSelect: true,
      observation: null,
      selections: [{ selection, needsReview: true, boundaryReached: true }],
      currentShadow: { awaitingSelection: true, affectedDeviceIds: [id], enforced: false },
    };
    expect(c.deviceRetentionInspectionSchema.parse(inspection)).toEqual(inspection);
    expect(
      c.deviceRetentionInspectionSchema.safeParse({
        ...inspection,
        currentShadow: { ...inspection.currentShadow, enforced: true },
      }).success,
    ).toBe(false);
    expect(
      c.deviceRetentionInspectionSchema.safeParse({
        ...inspection,
        currentShadow: { ...inspection.currentShadow, affectedDeviceIds: [id, id] },
      }).success,
    ).toBe(false);
  });
  it("exposes matching cabinet and platform inspect/preview/confirm routes", () => {
    for (const [map, prefix] of [
      [c.cabinetDeviceRetentionContracts, ""],
      [c.platformDeviceRetentionContracts, "/platform/tenants/:tenantId"],
    ] as const) {
      expect(map.inspect).toEqual({
        method: "GET",
        path: `${prefix}/device-licensing/retention`,
        response: c.deviceRetentionInspectionSchema,
      });
      expect(map.preview).toEqual({
        method: "POST",
        path: `${prefix}/device-licensing/retention/preview`,
        status: 200,
        body: c.deviceRetentionPreviewRequestSchema,
        response: c.deviceRetentionPreviewSchema,
      });
      expect(map.confirm).toEqual({
        method: "POST",
        path: `${prefix}/device-licensing/retention/confirm`,
        status: 200,
        body: c.deviceRetentionConfirmSchema,
        response: c.deviceRetentionReceiptSchema,
      });
    }
  });
});
