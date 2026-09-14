import { describe, expect, it } from "vitest";

import { grantRollbackPreparationSchema, platformGrantRollbackContracts } from "../src/index.js";

const ids = {
  request: "018f7bd1-4420-4b13-9f77-89f3a5374801",
  preparation: "018f7bd1-4420-4b13-9f77-89f3a5374802",
  activation: "018f7bd1-4420-4b13-9f77-89f3a5374803",
  activation2: "018f7bd1-4420-4b13-9f77-89f3a5374804",
  activationPreparation: "018f7bd1-4420-4b13-9f77-89f3a5374805",
  tenant: "tenant-a",
  subscription: "018f7bd1-4420-4b13-9f77-89f3a5374806",
  device: "018f7bd1-4420-4b13-9f77-89f3a5374807",
  assignment: "018f7bd1-4420-4b13-9f77-89f3a5374808",
  configuration: "018f7bd1-4420-4b13-9f77-89f3a5374809",
  basePolicy: "018f7bd1-4420-4b13-9f77-89f3a5374810",
  strictPolicy: "018f7bd1-4420-4b13-9f77-89f3a5374811",
  observePolicy: "018f7bd1-4420-4b13-9f77-89f3a5374812",
} as const;

const prepare = {
  protocol: "offline-grants-rollback-v1",
  activationIds: [ids.activation],
  decisionReference: "CAB-2026-0914-RB",
  requestId: ids.request,
} as const;

const member = {
  activationId: ids.activation,
  activationPreparationId: ids.activationPreparation,
  tenantId: ids.tenant,
  tenantName: "Factory A",
  subscriptionId: ids.subscription,
  deviceId: ids.device,
  deviceKind: "station",
  deviceName: "Line 1",
  credentialEpoch: 3,
  assignmentId: ids.assignment,
  configurationId: ids.configuration,
  basePolicyId: ids.basePolicy,
  strictPolicyId: ids.strictPolicy,
  activatedAt: "2026-09-14T09:00:00.000Z",
} as const;

const preparation = {
  protocol: "offline-grants-rollback-v1",
  id: ids.preparation,
  state: "prepared",
  requestId: ids.request,
  rollbackDigest: "a".repeat(64),
  members: [member],
  decisionReference: "CAB-2026-0914-RB",
  preparedBy: { userId: "platform-user-1", role: "platform_admin" },
  preparedAt: "2026-09-14T09:05:00.000Z",
  expiresAt: "2026-09-14T09:35:00.000Z",
  confirmedBy: null,
  confirmedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  cancellationReason: null,
  observePolicy: null,
} as const;

describe("offline grant rollback contracts", () => {
  it("lists active rollback candidates with server-owned identities", () => {
    const candidate = {
      activationId: ids.activation,
      tenantId: ids.tenant,
      tenantName: "Factory A",
      subscriptionId: ids.subscription,
      deviceId: ids.device,
      deviceKind: "station",
      deviceName: "Line 1",
      basePolicyId: ids.basePolicy,
      strictPolicyId: ids.strictPolicy,
      strictDecisionReference: "CAB-2026-0914-ACT",
      activatedAt: "2026-09-14T09:00:00.000Z",
    } as const;
    expect(
      platformGrantRollbackContracts.candidates.response.parse({
        items: [candidate],
        nextCursor: null,
      }),
    ).toEqual({ items: [candidate], nextCursor: null });
    expect(
      platformGrantRollbackContracts.candidates.query.parse({
        tenantId: ids.tenant,
        deviceKind: "station",
        limit: "20",
      }),
    ).toEqual({ tenantId: ids.tenant, deviceKind: "station", limit: 20 });
  });

  it("accepts only unique bounded activation IDs", () => {
    expect(platformGrantRollbackContracts.prepare.body.parse(prepare)).toEqual(prepare);
    expect(
      platformGrantRollbackContracts.prepare.body.safeParse({
        ...prepare,
        activationIds: [ids.activation, ids.activation],
      }).success,
    ).toBe(false);
    expect(
      platformGrantRollbackContracts.prepare.body.safeParse({
        ...prepare,
        activationIds: Array.from(
          { length: 201 },
          (_, index) => `018f7bd1-4420-4b13-8000-${index.toString(16).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
    expect(
      platformGrantRollbackContracts.prepare.body.safeParse({ ...prepare, tenantId: "forged" })
        .success,
    ).toBe(false);
  });

  it("validates complete prepared state and owner facts", () => {
    expect(grantRollbackPreparationSchema.parse(preparation)).toEqual(preparation);
    expect(
      grantRollbackPreparationSchema.safeParse({
        ...preparation,
        members: [{ ...member, deviceKind: "kiosk", assignmentId: null }],
      }).success,
    ).toBe(true);
    expect(
      grantRollbackPreparationSchema.safeParse({
        ...preparation,
        members: [{ ...member, assignmentId: null }],
      }).success,
    ).toBe(false);
  });

  it("requires state-consistent confirmed and needs-review receipts", () => {
    const observePolicy = {
      id: ids.observePolicy,
      policyKey: "factory-standard",
      version: 9,
      status: "approved",
      offlineGrant: {
        version: 1,
        maxOfflineMs: 3_600_000,
        maxCompletionMs: 86_400_000,
        taskBounds: {},
        rollout: {
          protocol: "offline-grants-v1",
          mode: "observe",
          deviceIds: [ids.device],
          decisionReference: "CAB-2026-0914-RB",
        },
      },
      payloadHash: "b".repeat(64),
      decisionReference: "CAB-2026-0914-RB",
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
      observePolicy,
    } as const;
    expect(
      platformGrantRollbackContracts.confirm.response.parse({
        status: "confirmed",
        requestId: ids.request,
        preparation: confirmed,
      }),
    ).toMatchObject({ status: "confirmed", preparation: { state: "confirmed" } });
    expect(
      platformGrantRollbackContracts.confirm.response.parse({
        status: "needs_review",
        requestId: ids.request,
        preparation: {
          ...preparation,
          state: "needs_review",
          confirmedBy: { userId: "platform-user-2", role: "platform_admin" },
          confirmedAt: "2026-09-14T09:10:00.000Z",
        },
        reasons: ["activation_inactive"],
      }),
    ).toMatchObject({ status: "needs_review", reasons: ["activation_inactive"] });
    expect(
      platformGrantRollbackContracts.confirm.response.safeParse({
        status: "confirmed",
        requestId: ids.request,
        preparation,
      }).success,
    ).toBe(false);
  });

  it("trims cancellation reason and rejects unknown fields", () => {
    expect(
      platformGrantRollbackContracts.cancel.body.parse({
        protocol: "offline-grants-rollback-v1",
        reason: "  Wrong cohort  ",
        requestId: ids.request,
      }),
    ).toEqual({
      protocol: "offline-grants-rollback-v1",
      reason: "Wrong cohort",
      requestId: ids.request,
    });
    expect(
      platformGrantRollbackContracts.confirm.body.safeParse({
        protocol: "offline-grants-rollback-v1",
        rollbackDigest: "a".repeat(64),
        requestId: ids.request,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
