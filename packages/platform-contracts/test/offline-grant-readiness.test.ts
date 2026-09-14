import { describe, expect, it } from "vitest";
import {
  grantClientReadinessRequestSchema,
  grantClientReadinessResponseSchema,
  platformGrantReadinessListQuerySchema,
  platformGrantReadinessListResponseSchema,
  platformGrantReadinessPreviewRequestSchema,
  platformGrantReadinessPreviewResponseSchema,
} from "../src/index.js";

const requestId = "018f7bd1-4420-4b13-9f77-89f3a5374763";
const policyId = "018f7bd1-4420-4b13-9f77-89f3a5374764";
const deviceId = "018f7bd1-4420-4b13-9f77-89f3a5374765";
const verifiedGrantId = "018f7bd1-4420-4b13-9f77-89f3a5374766";
const policyRevision = "policy:factory-standard:7";

describe("offline grant client readiness contracts", () => {
  it("accepts the exact negotiated durable-install report", () => {
    const request = {
      protocol: "offline-grants-v1",
      capability: "offline-grants-readiness-v1",
      requestId,
      clientBuild: "station:1.4.2",
      storageRevision: 14,
      installed: {
        mode: "observe",
        policyRevision,
        keysetRevision: "keyset-7",
        verifiedGrantId,
      },
    };

    expect(grantClientReadinessRequestSchema.parse(request)).toEqual(request);
    expect(
      grantClientReadinessRequestSchema.safeParse({ ...request, eligible: true }).success,
    ).toBe(false);
    expect(
      grantClientReadinessRequestSchema.safeParse({
        ...request,
        installed: { ...request.installed, extra: true },
      }).success,
    ).toBe(false);
  });

  it("bounds client metadata and accepts nullable installed facts", () => {
    const request = {
      protocol: "offline-grants-v1",
      capability: "offline-grants-readiness-v1",
      requestId,
      clientBuild: "kiosk:1.0.0",
      storageRevision: 1,
      installed: {
        mode: "observe",
        policyRevision: null,
        keysetRevision: null,
        verifiedGrantId: null,
      },
    };

    expect(grantClientReadinessRequestSchema.safeParse(request).success).toBe(true);
    expect(
      grantClientReadinessRequestSchema.safeParse({ ...request, clientBuild: "" }).success,
    ).toBe(false);
    expect(
      grantClientReadinessRequestSchema.safeParse({ ...request, clientBuild: "x".repeat(101) })
        .success,
    ).toBe(false);
    expect(
      grantClientReadinessRequestSchema.safeParse({ ...request, storageRevision: 0 }).success,
    ).toBe(false);
  });

  it("strictly validates the acknowledgement", () => {
    const response = {
      protocol: "offline-grants-v1",
      requestId,
      receivedAt: "2026-09-14T09:30:00.000Z",
      accepted: true,
      matchesCurrentConfiguration: true,
      verifiedGrantMatched: true,
    };

    expect(grantClientReadinessResponseSchema.parse(response)).toEqual(response);
    expect(
      grantClientReadinessResponseSchema.safeParse({ ...response, eligible: true }).success,
    ).toBe(false);
  });
});

const eligibleRow = {
  tenantId: "tenant-a",
  tenantName: "Factory A",
  deviceId,
  deviceKind: "station",
  deviceName: "Line 1",
  credentialEpoch: 4,
  credentialActive: true,
  revokedAt: null,
  assignmentId: "018f7bd1-4420-4b13-9f77-89f3a5374767",
  lastSeenAt: "2026-09-14T09:31:00.000Z",
  currentPolicy: {
    id: policyId,
    revision: policyRevision,
    approved: true,
  },
  signing: { configured: true, keysetRevision: "keyset-7" },
  configuration: {
    id: "018f7bd1-4420-4b13-9f77-89f3a5374768",
    mode: "observe",
    policyRevision,
  },
  clientReport: {
    id: "018f7bd1-4420-4b13-9f77-89f3a5374769",
    receivedAt: "2026-09-14T09:30:00.000Z",
    clientBuild: "station:1.4.2",
    storageRevision: 14,
    credentialEpoch: 4,
    mode: "observe",
    policyRevision,
    keysetRevision: "keyset-7",
    verifiedGrantId,
    matchesCurrentConfiguration: true,
    verifiedGrantMatched: true,
  },
  verifiedGrant: {
    id: verifiedGrantId,
    issuedAt: "2026-09-14T09:29:00.000Z",
    kid: "grant-key-7",
    retired: false,
  },
  evidence: { acceptedCount: 0, lastAcceptedAt: null },
  eligibility: { status: "eligible", reasons: [] },
} as const;

describe("platform offline grant readiness contracts", () => {
  it("normalizes and bounds readiness list queries", () => {
    expect(platformGrantReadinessListQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(
      platformGrantReadinessListQuerySchema.parse({
        tenantId: "tenant-a",
        deviceKind: "handheld",
        readiness: "blocked",
        policyId,
        limit: "100",
      }),
    ).toEqual({
      tenantId: "tenant-a",
      deviceKind: "handheld",
      readiness: "blocked",
      policyId,
      limit: 100,
    });

    for (const cursor of ["", "not a cursor", "=".repeat(5), "x".repeat(4_097)]) {
      expect(platformGrantReadinessListQuerySchema.safeParse({ cursor }).success).toBe(false);
    }
    expect(platformGrantReadinessListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(platformGrantReadinessListQuerySchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it("requires exact eligibility reason invariants", () => {
    const list = {
      asOf: "2026-09-14T09:32:00.000Z",
      items: [eligibleRow],
      aggregates: { total: 1, eligible: 1, blocked: 0, reasons: {} },
      nextCursor: null,
    };

    expect(platformGrantReadinessListResponseSchema.parse(list)).toEqual(list);
    expect(
      platformGrantReadinessListResponseSchema.safeParse({
        ...list,
        items: [
          {
            ...eligibleRow,
            eligibility: { status: "blocked", reasons: [] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      platformGrantReadinessListResponseSchema.safeParse({
        ...list,
        items: [
          {
            ...eligibleRow,
            eligibility: { status: "eligible", reasons: ["client_report_missing"] },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires a unique bounded strict-mode cohort", () => {
    const body = { policyId, mode: "strict", deviceIds: [deviceId], requestId };
    expect(platformGrantReadinessPreviewRequestSchema.parse(body)).toEqual(body);
    expect(
      platformGrantReadinessPreviewRequestSchema.safeParse({
        ...body,
        deviceIds: [deviceId, deviceId],
      }).success,
    ).toBe(false);
    expect(
      platformGrantReadinessPreviewRequestSchema.safeParse({
        ...body,
        deviceIds: Array.from(
          { length: 201 },
          (_, index) => `018f7bd1-4420-4b13-8000-${index.toString(16).padStart(12, "0")}`,
        ),
      }).success,
    ).toBe(false);
  });

  it("pins a non-mutating preview snapshot and digest", () => {
    const response = {
      requestId,
      policyId,
      policyRevision,
      mode: "strict",
      asOf: "2026-09-14T09:32:00.000Z",
      previewDigest: "a".repeat(64),
      items: [eligibleRow],
      aggregates: { total: 1, eligible: 1, blocked: 0, reasons: {} },
    };

    expect(platformGrantReadinessPreviewResponseSchema.parse(response)).toEqual(response);
    expect(
      platformGrantReadinessPreviewResponseSchema.safeParse({ ...response, activate: true })
        .success,
    ).toBe(false);
  });
});
