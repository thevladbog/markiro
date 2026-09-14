import type { PlatformGrantActivationPreparation } from "@markiro/platform-contracts";

import {
  approvedPolicy,
  asOf,
  policyId,
  policyRevision,
  readyDeviceId,
  readyRow,
} from "./offline-grant-readiness-fixtures.js";

export const activationId = "99999999-9999-4999-8999-999999999999";
export const activationRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const confirmRequestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const cancelRequestId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const preparedActivation: PlatformGrantActivationPreparation = {
  protocol: "offline-grants-activation-v1",
  id: activationId,
  state: "prepared",
  requestId: activationRequestId,
  previewRequestId: "44444444-4444-4444-8444-444444444444",
  previewDigest: "a".repeat(64),
  preparationDigest: "d".repeat(64),
  basePolicy: {
    id: policyId,
    policyKey: approvedPolicy.policyKey,
    version: approvedPolicy.version,
    payloadHash: approvedPolicy.payloadHash,
    revision: policyRevision,
  },
  members: [
    {
      tenantId: readyRow.tenantId,
      tenantName: readyRow.tenantName,
      subscriptionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      deviceId: readyDeviceId,
      deviceKind: "station",
      deviceName: readyRow.deviceName,
      credentialEpoch: readyRow.credentialEpoch,
      assignmentId: readyRow.assignmentId,
      configurationId: readyRow.configuration!.id,
      clientReportId: readyRow.clientReport!.id,
      verifiedGrantId: readyRow.verifiedGrant!.id,
      keysetRevision: readyRow.signing.keysetRevision!,
      entitlementRevision: "7",
    },
  ],
  decisionReference: "CAB-2026-0914",
  preparedBy: { userId: "user-1", role: "platform_admin" },
  preparedAt: asOf,
  expiresAt: "2026-09-14T12:30:00.000Z",
  confirmedBy: null,
  confirmedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  cancellationReason: null,
  rolloutPolicy: null,
};
