import type {
  DeviceReplacementObservation,
  DeviceReplacementPreparation,
  DeviceReplacementPreview,
  WorkingDevicePool,
} from "@markiro/platform-contracts";
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
export const preparation: DeviceReplacementPreparation = {
  id: PROJECT,
  sourceDeviceId: SOURCE,
  revision: 1,
  state: "prepared",
  preparedAt: "2026-09-12T10:00:00.000Z",
  cancelledAt: null,
  observation,
};
export function preview(requestId: string): DeviceReplacementPreview {
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

export const EXECUTION = "55555555-5555-4555-8555-555555555555";
export const BOUNDARY = "2026-09-18T12:30:00.000Z";
export const measuredReport = {
  reportSequence: 7,
  clientBuild: "station-2.1",
  storageRevision: 19,
  pending: {
    scans: 3,
    inventories: 2,
    shiftClosures: 1,
    productLabels: 4,
    boxes: 5,
    exceptions: "unsupported" as const,
  },
  conflicts: 6,
  unknownPrints: 8,
  activeTasks: [{ taskId: SOURCE, kind: "shift" as const }],
  installedGrants: [{ grantId: SECOND }],
  journal: { digest: "a".repeat(64), highestSequence: 23 },
};
export function workflowPreparation(
  state: DeviceReplacementPreparation["state"] = "draining",
  recoveryState: NonNullable<
    DeviceReplacementPreparation["execution"]
  >["recoveryState"] = "not_required",
): DeviceReplacementPreparation {
  return {
    ...preparation,
    state,
    revision: 3,
    ...(state !== "prepared" && state !== "cancelled"
      ? {
          readiness: {
            intentId: PREVIEW,
            credentialEpoch: 4,
            receivedAt: "2026-09-17T12:00:00.000Z",
            eligibility:
              state === "ready"
                ? { status: "eligible" as const, reasons: [] as [] }
                : {
                    status: "blocked" as const,
                    reasons: [
                      "pending_scans",
                      "pending_inventories",
                      "pending_shift_closures",
                      "pending_product_labels",
                      "pending_boxes",
                      "client_upgrade_required",
                      "conflicts",
                      "unknown_prints",
                      "active_tasks",
                      "installed_grants",
                    ],
                  },
            report:
              state === "ready"
                ? {
                    ...measuredReport,
                    pending: {
                      scans: 0,
                      inventories: 0,
                      shiftClosures: 0,
                      productLabels: 0,
                      boxes: 0,
                      exceptions: 0,
                    },
                    conflicts: 0,
                    unknownPrints: 0,
                    activeTasks: [],
                    installedGrants: [],
                  }
                : measuredReport,
          },
        }
      : {}),
    ...(state === "executing" || state === "completed"
      ? {
          execution: {
            id: EXECUTION,
            revision: 9,
            step: state === "completed" ? ("transferred" as const) : ("revoke_pending" as const),
            mode: recoveryState === "not_required" ? ("normal" as const) : ("emergency" as const),
            targetDeviceId: state === "completed" ? SECOND : null,
            executedAt: state === "completed" ? "2026-09-17T12:15:00.000Z" : null,
            newWorkAllowedAt: BOUNDARY,
            recoveryState,
          },
          recovery: {
            state: recoveryState,
            closedAt: ["completed", "evidence_unavailable"].includes(recoveryState)
              ? "2026-09-17T13:00:00.000Z"
              : null,
          },
        }
      : {}),
  };
}
export function executionPreview(requestId: string, mode: "normal" | "emergency" = "normal") {
  return {
    id: PREVIEW,
    requestId,
    preparationId: PROJECT,
    expectedRevision: 3,
    mode,
    asOf: "2026-09-17T12:00:00.000Z",
    expiresAt: "2026-09-17T12:05:00.000Z",
    digest: "b".repeat(64),
    newWorkAllowedAt: BOUNDARY,
  };
}
