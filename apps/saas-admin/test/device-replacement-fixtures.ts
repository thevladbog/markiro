import type { DeviceReplacementObservation, WorkingDevicePool } from "@markiro/platform-contracts";
export const SOURCE = "11111111-1111-4111-8111-111111111111";
export const SECOND = "22222222-2222-4222-8222-222222222222";
export const PREVIEW = "33333333-3333-4333-8333-333333333333";
export const PROJECT = "44444444-4444-4444-8444-444444444444";
export const pool: WorkingDevicePool = {
  tenantId: "tenant-1",
  usage: 1,
  limit: 2,
  canCancelReservations: true,
  integrity: "ready",
  devices: [SOURCE, SECOND].map((deviceId, i) => ({
    deviceId,
    name: `Source ${i + 1}`,
    kind: "station",
    assignmentId: deviceId,
    revision: 1,
    state: "assigned",
    releaseReason: null,
    slotOccupied: true,
    canCancel: false,
    blockedReason: "already_paired",
    connectionStatus: "offline",
    pairedAt: null,
    lastSeenAt: null,
  })),
};
export const observation: DeviceReplacementObservation = {
  source: {
    deviceId: SOURCE,
    name: "Source 1",
    kind: "station",
    assignmentId: SOURCE,
    revision: 1,
    state: "assigned",
    slotOccupied: true,
    lineId: null,
    pairedAt: null,
    lastSeenAt: null,
    revokedAt: null,
  },
  target: { name: "Future device", kind: "handheld" },
  usage: 1,
  limit: 2,
  preparationSlotDelta: 0,
  expectedTransferSlotDelta: 0,
  knownServerWork: { activeShifts: 2, activeInventories: 1, printJobs: 3, quarantineBatches: 4 },
  localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
  execution: {
    available: false,
    reasons: [
      "transfer_not_available",
      "local_data_unknown",
      "source_authority_transition_required",
    ],
  },
};
export const preparation = {
  id: PROJECT,
  sourceDeviceId: SOURCE,
  revision: 1,
  state: "prepared" as const,
  preparedAt: "2026-09-12T10:00:00.000Z",
  cancelledAt: null,
  observation,
};
export function preview(requestId: string) {
  return {
    id: PREVIEW,
    requestId,
    sourceDeviceId: SOURCE,
    createdAt: "2026-09-12T10:00:00.000Z",
    expiresAt: "2026-09-12T10:05:00.000Z",
    observation,
  };
}
export function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
