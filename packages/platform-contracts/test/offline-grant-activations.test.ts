import { describe, expect, it } from "vitest";

import {
  grantActivationPreparationSchema,
  platformGrantActivationContracts,
} from "../src/index.js";

const ids = {
  request: "018f7bd1-4420-4b13-9f77-89f3a5374701",
  previewRequest: "018f7bd1-4420-4b13-9f77-89f3a5374702",
  policy: "018f7bd1-4420-4b13-9f77-89f3a5374703",
  preparation: "018f7bd1-4420-4b13-9f77-89f3a5374704",
  device: "018f7bd1-4420-4b13-9f77-89f3a5374705",
  subscription: "018f7bd1-4420-4b13-9f77-89f3a5374706",
  assignment: "018f7bd1-4420-4b13-9f77-89f3a5374707",
  configuration: "018f7bd1-4420-4b13-9f77-89f3a5374708",
  report: "018f7bd1-4420-4b13-9f77-89f3a5374709",
  grant: "018f7bd1-4420-4b13-9f77-89f3a5374710",
} as const;

const digest = "a".repeat(64);

const prepare = {
  protocol: "offline-grants-activation-v1",
  previewRequestId: ids.previewRequest,
  previewDigest: digest,
  policyId: ids.policy,
  deviceIds: [ids.device],
  decisionReference: "CAB-2026-0914",
  requestId: ids.request,
} as const;

const preparation = {
  protocol: "offline-grants-activation-v1",
  id: ids.preparation,
  state: "prepared",
  requestId: ids.request,
  previewRequestId: ids.previewRequest,
  previewDigest: digest,
  preparationDigest: "b".repeat(64),
  basePolicy: {
    id: ids.policy,
    policyKey: "factory-standard",
    version: 7,
    payloadHash: "c".repeat(64),
    revision: `${ids.policy}:7:${"c".repeat(64)}`,
  },
  members: [
    {
      tenantId: "tenant-a",
      tenantName: "Factory A",
      subscriptionId: ids.subscription,
      deviceId: ids.device,
      deviceKind: "station",
      deviceName: "Line 1",
      credentialEpoch: 4,
      assignmentId: ids.assignment,
      configurationId: ids.configuration,
      clientReportId: ids.report,
      verifiedGrantId: ids.grant,
      keysetRevision: "keyset-7",
      entitlementRevision: "12",
    },
  ],
  decisionReference: "CAB-2026-0914",
  preparedBy: { userId: "platform-user-1", role: "platform_admin" },
  preparedAt: "2026-09-14T09:00:00.000Z",
  expiresAt: "2026-09-14T09:30:00.000Z",
  confirmedBy: null,
  confirmedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  cancellationReason: null,
  rolloutPolicy: null,
} as const;

describe("offline grant activation contracts", () => {
  it("accepts an exact bounded prepare request", () => {
    expect(platformGrantActivationContracts.prepare.body.parse(prepare)).toEqual(prepare);
    expect(
      platformGrantActivationContracts.prepare.body.safeParse({ ...prepare, unknown: true })
        .success,
    ).toBe(false);
    expect(
      platformGrantActivationContracts.prepare.body.safeParse({
        ...prepare,
        deviceIds: [ids.device, ids.device],
      }).success,
    ).toBe(false);
    expect(
      platformGrantActivationContracts.prepare.body.safeParse({
        ...prepare,
        deviceIds: Array.from(
          { length: 201 },
          (_, index) => `018f7bd1-4420-4b13-8000-${index.toString(16).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("requires lowercase sha256 digests and strict confirmation identity", () => {
    const confirm = {
      protocol: "offline-grants-activation-v1",
      preparationDigest: digest,
      requestId: ids.request,
    } as const;
    expect(platformGrantActivationContracts.confirm.body.parse(confirm)).toEqual(confirm);
    expect(
      platformGrantActivationContracts.confirm.body.safeParse({
        ...confirm,
        preparationDigest: "A".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      platformGrantActivationContracts.confirm.body.safeParse({ ...confirm, extra: true }).success,
    ).toBe(false);
  });

  it("bounds and trims cancellation reasons", () => {
    expect(
      platformGrantActivationContracts.cancel.body.parse({
        protocol: "offline-grants-activation-v1",
        reason: "  Cohort changed  ",
        requestId: ids.request,
      }),
    ).toEqual({
      protocol: "offline-grants-activation-v1",
      reason: "Cohort changed",
      requestId: ids.request,
    });
    expect(
      platformGrantActivationContracts.cancel.body.safeParse({
        protocol: "offline-grants-activation-v1",
        reason: "x".repeat(1_001),
        requestId: ids.request,
      }).success,
    ).toBe(false);
  });

  it("validates a complete preparation and rejects incomplete actor facts", () => {
    expect(grantActivationPreparationSchema.parse(preparation)).toEqual(preparation);
    expect(
      grantActivationPreparationSchema.safeParse({
        ...preparation,
        preparedBy: { userId: "platform-user-1" },
      }).success,
    ).toBe(false);
    expect(
      grantActivationPreparationSchema.safeParse({ ...preparation, resultPolicy: null }).success,
    ).toBe(false);
  });

  it("accepts only state-consistent confirmed and stale responses", () => {
    const rolloutPolicy = {
      id: "018f7bd1-4420-4b13-9f77-89f3a5374711",
      policyKey: "factory-standard",
      version: 8,
      status: "approved",
      offlineGrant: {
        version: 1,
        maxOfflineMs: 3_600_000,
        maxCompletionMs: 86_400_000,
        taskBounds: {},
        rollout: {
          protocol: "offline-grants-v1",
          mode: "strict",
          deviceIds: [ids.device],
          decisionReference: "CAB-2026-0914",
        },
      },
      payloadHash: "d".repeat(64),
      decisionReference: "CAB-2026-0914",
      approvedAt: "2026-09-14T09:10:00.000Z",
      approvedByPlatformUserId: "platform-user-2",
      createdByPlatformUserId: "platform-user-1",
      createdAt: "2026-09-14T09:10:00.000Z",
    } as const;
    const confirmed = {
      ...preparation,
      state: "confirmed",
      confirmedBy: { userId: "platform-user-2", role: "platform_admin" },
      confirmedAt: "2026-09-14T09:10:00.000Z",
      rolloutPolicy,
    } as const;
    expect(
      platformGrantActivationContracts.confirm.response.parse({
        status: "confirmed",
        requestId: ids.request,
        preparation: confirmed,
        activationIds: ["018f7bd1-4420-4b13-9f77-89f3a5374712"],
      }),
    ).toMatchObject({ status: "confirmed", preparation: { state: "confirmed" } });
    expect(
      platformGrantActivationContracts.confirm.response.parse({
        status: "needs_review",
        requestId: ids.request,
        preparation: { ...preparation, state: "needs_review" },
        reasons: ["client_report_stale"],
      }),
    ).toMatchObject({ status: "needs_review", reasons: ["client_report_stale"] });
    expect(
      platformGrantActivationContracts.confirm.response.safeParse({
        status: "confirmed",
        requestId: ids.request,
        preparation,
        activationIds: [],
      }).success,
    ).toBe(false);
  });
});
