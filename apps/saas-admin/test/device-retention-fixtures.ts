import type {
  EntitlementSnapshotV1,
  DeviceRetentionDevice,
  DeviceRetentionObservation,
  DeviceRetentionPreviewRequest,
  DeviceRetentionPreview,
  DeviceRetentionSelection,
  DeviceRetentionInspection,
} from "@markiro/platform-contracts";
export const id = "11111111-1111-4111-8111-111111111111";
export const otherId = "22222222-2222-4222-8222-222222222222";
const at = "2026-09-12T10:00:00.000Z";
const boundaryAt = "2026-09-12T10:03:00.000Z";
const quota = (limit: number | null) => ({
  limit,
  used: 1,
  remaining: limit === null ? null : Math.max(0, limit - 1),
});
const snapshot = (asOf: string, limit: number | null = 1): EntitlementSnapshotV1 => ({
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
  readiness: { mode: "shadow", reasons: ["lifecycle_policy_required"] },
  historical: { available: false },
  connectivity: { observedAt: asOf, chz: "unknown", nationalCatalog: "unknown" },
});
export const device: DeviceRetentionDevice = {
  deviceId: id,
  name: "Line station",
  kind: "station",
  assignmentId: otherId,
  revision: 1,
  state: "reserved",
  eligible: true,
  reasons: [],
  knownServerWork: { activeShifts: 0, activeInventories: 1, printJobs: 0, quarantineBatches: 0 },
  localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
};
export const observation: DeviceRetentionObservation = {
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
export const request: DeviceRetentionPreviewRequest = {
  requestId: id,
  boundaryKey: observation.boundary.key,
  selectedDeviceIds: [id],
  expectedRevision: 0,
  reason: "Downgrade",
};
export const preview: DeviceRetentionPreview = {
  id: otherId,
  requestId: id,
  createdAt: at,
  expiresAt: boundaryAt,
  expectedRevision: 0,
  selectedDeviceIds: [id],
  observation,
};
export const selection: DeviceRetentionSelection = {
  id: otherId,
  revision: 1,
  preparedAt: at,
  selectedDeviceIds: [id],
  observation,
};

export const inspection: DeviceRetentionInspection = {
  canSelect: true,
  observation,
  selections: [],
  currentShadow: { awaitingSelection: false, affectedDeviceIds: [], enforced: false },
};
export function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
