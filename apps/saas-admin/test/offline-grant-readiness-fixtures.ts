import type {
  OfflineGrantPolicyRecord,
  PlatformGrantReadinessListResponse,
  PlatformGrantReadinessPreviewResponse,
  PlatformGrantReadinessRow,
} from "@markiro/platform-contracts";

export const policyId = "11111111-1111-4111-8111-111111111111";
export const readyDeviceId = "22222222-2222-4222-8222-222222222222";
export const blockedDeviceId = "33333333-3333-4333-8333-333333333333";
export const requestId = "44444444-4444-4444-8444-444444444444";
export const asOf = "2026-09-14T12:00:00.000Z";
export const previewDigest = "a".repeat(64);
export const policyRevision = `${policyId}:1:${"b".repeat(64)}`;

export const approvedPolicy: OfflineGrantPolicyRecord = {
  id: policyId,
  policyKey: "factory-default",
  version: 1,
  status: "approved",
  offlineGrant: {
    version: 1,
    maxOfflineMs: 28_800_000,
    maxCompletionMs: 86_400_000,
    taskBounds: {},
  },
  payloadHash: "b".repeat(64),
  decisionReference: "pilot-approval",
  approvedAt: asOf,
  approvedByPlatformUserId: "platform-admin",
  createdByPlatformUserId: "platform-admin",
  createdAt: asOf,
};

function row(deviceId: string, deviceName: string): PlatformGrantReadinessRow {
  return {
    tenantId: "tenant-ready",
    tenantName: "Ready tenant",
    deviceId,
    deviceKind: "station",
    deviceName,
    credentialEpoch: 3,
    credentialActive: true,
    revokedAt: null,
    assignmentId: "55555555-5555-4555-8555-555555555555",
    lastSeenAt: asOf,
    currentPolicy: { id: policyId, revision: policyRevision, approved: true },
    signing: { configured: true, keysetRevision: "keyset-7" },
    configuration: {
      id: "66666666-6666-4666-8666-666666666666",
      mode: "observe",
      policyRevision,
    },
    clientReport: {
      id: "77777777-7777-4777-8777-777777777777",
      receivedAt: asOf,
      clientBuild: "station:2.0.0",
      storageRevision: 14,
      credentialEpoch: 3,
      mode: "observe",
      policyRevision,
      keysetRevision: "keyset-7",
      verifiedGrantId: "88888888-8888-4888-8888-888888888888",
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    },
    verifiedGrant: {
      id: "88888888-8888-4888-8888-888888888888",
      issuedAt: asOf,
      kid: "current-key",
      retired: false,
    },
    evidence: { acceptedCount: 2, lastAcceptedAt: asOf },
    eligibility: { status: "eligible", reasons: [] },
  };
}

export const readyRow = row(readyDeviceId, "Line station");
export const blockedRow: PlatformGrantReadinessRow = {
  ...row(blockedDeviceId, "Packing station"),
  clientReport: null,
  eligibility: { status: "blocked", reasons: ["client_report_missing"] },
};

export const readinessList: PlatformGrantReadinessListResponse = {
  asOf,
  items: [readyRow, blockedRow],
  aggregates: { total: 2, eligible: 1, blocked: 1, reasons: { client_report_missing: 1 } },
  nextCursor: null,
};

export const readinessPreview: PlatformGrantReadinessPreviewResponse = {
  requestId,
  policyId,
  policyRevision,
  mode: "strict",
  asOf,
  previewDigest,
  items: [readyRow],
  aggregates: { total: 1, eligible: 1, blocked: 0, reasons: {} },
};
