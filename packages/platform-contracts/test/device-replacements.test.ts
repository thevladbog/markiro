import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const previewId = "22222222-2222-4222-8222-222222222222";
const sourceDeviceId = "33333333-3333-4333-8333-333333333333";
const assignmentId = "44444444-4444-4444-8444-444444444444";
const preparationId = "55555555-5555-4555-8555-555555555555";
const createdAt = "2026-09-12T10:00:00.000Z";
const expiresAt = "2026-09-12T10:05:00.000Z";

const observation = {
  source: {
    deviceId: sourceDeviceId,
    name: "Линия 1",
    kind: "station",
    lineId: null,
    assignmentId,
    revision: 4,
    state: "assigned",
    slotOccupied: true,
    pairedAt: "2026-08-12T10:00:00.000Z",
    lastSeenAt: "2026-09-12T09:59:00.000Z",
    revokedAt: null,
  },
  target: { name: "Линия 1 — замена", kind: "station" },
  usage: 2,
  limit: null,
  preparationSlotDelta: 0,
  expectedTransferSlotDelta: 0,
  knownServerWork: {
    activeShifts: 1,
    activeInventories: 0,
    printJobs: 2,
    quarantineBatches: 0,
  },
  localData: { journals: "unknown", outbox: "unknown", printWork: "unknown" },
  execution: {
    available: false,
    reasons: [
      "transfer_not_available",
      "local_data_unknown",
      "source_authority_transition_required",
    ],
  },
} as const;

describe("device replacement contracts", () => {
  it("exports every strict replacement schema and contract map", () => {
    for (const name of [
      "deviceReplacementTargetSchema",
      "deviceReplacementPreviewRequestSchema",
      "deviceReplacementConfirmSchema",
      "deviceReplacementCancelSchema",
      "deviceReplacementObservationSchema",
      "deviceReplacementPreviewSchema",
      "deviceReplacementPreparationSchema",
      "deviceReplacementReceiptSchema",
      "deviceReplacementListSchema",
      "cabinetDeviceReplacementContracts",
      "platformDeviceReplacementContracts",
    ]) {
      expect(contracts).toHaveProperty(name);
    }
  });

  it("normalizes bounded target and reason text and rejects client authority fields", () => {
    expect(
      contracts.deviceReplacementPreviewRequestSchema.parse({
        requestId,
        target: { name: "  Новая линия  ", kind: "handheld" },
        reason: "  Плановая замена  ",
      }),
    ).toEqual({
      requestId,
      target: { name: "Новая линия", kind: "handheld" },
      reason: "Плановая замена",
    });

    const valid = {
      requestId,
      target: { name: "Новая линия", kind: "station" },
      reason: "Плановая замена",
    };
    for (const invalid of [
      { ...valid, requestId: "request" },
      { ...valid, target: { ...valid.target, name: " " } },
      { ...valid, target: { ...valid.target, name: "a".repeat(201) } },
      { ...valid, target: { ...valid.target, kind: "kiosk" } },
      { ...valid, reason: " " },
      { ...valid, reason: "a".repeat(1_001) },
      { ...valid, tenantId: "tenant-a" },
      { ...valid, generation: 2 },
      { ...valid, execute: true },
      { ...valid, force: true },
      { ...valid, ignorePending: true },
    ]) {
      expect(contracts.deviceReplacementPreviewRequestSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("keeps confirm and cancel identities strict and revision checked", () => {
    expect(contracts.deviceReplacementConfirmSchema.parse({ requestId, previewId })).toEqual({
      requestId,
      previewId,
    });
    expect(
      contracts.deviceReplacementConfirmSchema.safeParse({ requestId, previewId, force: true })
        .success,
    ).toBe(false);
    expect(
      contracts.deviceReplacementCancelSchema.parse({ requestId, expectedRevision: 2 }),
    ).toEqual({ requestId, expectedRevision: 2 });
    for (const expectedRevision of [0, -1, 1.5]) {
      expect(
        contracts.deviceReplacementCancelSchema.safeParse({ requestId, expectedRevision }).success,
      ).toBe(false);
    }
  });

  it("requires an unavailable execution with every invariant reason and unknown local data", () => {
    expect(contracts.deviceReplacementObservationSchema.parse(observation)).toEqual(observation);

    for (const invalid of [
      { ...observation, execution: { ...observation.execution, available: true } },
      {
        ...observation,
        execution: {
          ...observation.execution,
          reasons: observation.execution.reasons.filter(
            (reason) => reason !== "transfer_not_available",
          ),
        },
      },
      {
        ...observation,
        execution: {
          ...observation.execution,
          reasons: [...observation.execution.reasons, "transfer_complete"],
        },
      },
      { ...observation, localData: { ...observation.localData, journals: "empty" } },
      { ...observation, preparationSlotDelta: 1 },
      { ...observation, expectedTransferSlotDelta: -1 },
      { ...observation, usage: -1 },
      { ...observation, knownServerWork: { ...observation.knownServerWork, printJobs: 1.5 } },
      { ...observation, credentialId: "private" },
      { ...observation, execution: { ...observation.execution, privateReason: "internal" } },
    ]) {
      expect(contracts.deviceReplacementObservationSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("correlates source occupancy and preparation cancellation timestamps", () => {
    expect(
      contracts.deviceReplacementObservationSchema.safeParse({
        ...observation,
        source: {
          ...observation.source,
          state: "released",
          slotOccupied: false,
          revokedAt: createdAt,
        },
        expectedTransferSlotDelta: 1,
      }).success,
    ).toBe(true);
    expect(
      contracts.deviceReplacementObservationSchema.safeParse({
        ...observation,
        source: { ...observation.source, state: "released", slotOccupied: true },
      }).success,
    ).toBe(false);
    expect(
      contracts.deviceReplacementObservationSchema.safeParse({
        ...observation,
        expectedTransferSlotDelta: 1,
      }).success,
    ).toBe(false);
    expect(
      contracts.deviceReplacementObservationSchema.safeParse({
        ...observation,
        source: {
          ...observation.source,
          state: "released",
          slotOccupied: false,
          revokedAt: createdAt,
        },
        expectedTransferSlotDelta: 0,
      }).success,
    ).toBe(false);

    const preparation = {
      id: preparationId,
      sourceDeviceId,
      revision: 1,
      state: "prepared",
      preparedAt: createdAt,
      cancelledAt: null,
      observation,
    } as const;
    expect(contracts.deviceReplacementPreparationSchema.parse(preparation)).toEqual(preparation);
    expect(
      contracts.deviceReplacementPreparationSchema.safeParse({
        ...preparation,
        cancelledAt: createdAt,
      }).success,
    ).toBe(false);
    expect(
      contracts.deviceReplacementPreparationSchema.safeParse({
        ...preparation,
        state: "cancelled",
        cancelledAt: null,
      }).success,
    ).toBe(false);
    expect(
      contracts.deviceReplacementPreparationSchema.safeParse({
        ...preparation,
        sourceDeviceId: previewId,
      }).success,
    ).toBe(false);
  });

  it("accepts immutable preview, receipt and list projections without private fields", () => {
    const preview = {
      id: previewId,
      requestId,
      sourceDeviceId,
      createdAt,
      expiresAt,
      observation,
    } as const;
    const preparation = {
      id: preparationId,
      sourceDeviceId,
      revision: 2,
      state: "cancelled",
      preparedAt: createdAt,
      cancelledAt: expiresAt,
      observation,
    } as const;
    const receipt = { requestId, preparation } as const;
    const list = {
      canPrepare: true,
      items: [{ preparation, needsReview: true }],
    } as const;

    expect(contracts.deviceReplacementPreviewSchema.parse(preview)).toEqual(preview);
    expect(contracts.deviceReplacementReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(contracts.deviceReplacementListSchema.parse(list)).toEqual(list);
    for (const [schema, invalid] of [
      [contracts.deviceReplacementPreviewSchema, { ...preview, apiKeyId: "private" }],
      [contracts.deviceReplacementPreviewSchema, { ...preview, sourceDeviceId: preparationId }],
      [
        contracts.deviceReplacementPreviewSchema,
        { ...preview, expiresAt: "2026-09-12T10:05:00.001Z" },
      ],
      [contracts.deviceReplacementReceiptSchema, { ...receipt, reason: "private" }],
      [contracts.deviceReplacementListSchema, { ...list, actorId: "private" }],
    ] as const) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  });

  it("publishes separate cabinet and platform replacement routes with 200 mutations", () => {
    expect(contracts.cabinetDeviceReplacementContracts).toEqual({
      list: {
        method: "GET",
        path: "/device-licensing/replacements",
        response: contracts.deviceReplacementListSchema,
      },
      preview: {
        method: "POST",
        path: "/device-licensing/:deviceId/replacements/preview",
        status: 200,
        body: contracts.deviceReplacementPreviewRequestSchema,
        response: contracts.deviceReplacementPreviewSchema,
      },
      confirm: {
        method: "POST",
        path: "/device-licensing/:deviceId/replacements/confirm",
        status: 200,
        body: contracts.deviceReplacementConfirmSchema,
        response: contracts.deviceReplacementReceiptSchema,
      },
      cancel: {
        method: "POST",
        path: "/device-licensing/replacements/:preparationId/cancel",
        status: 200,
        body: contracts.deviceReplacementCancelSchema,
        response: contracts.deviceReplacementReceiptSchema,
      },
    });
    expect(contracts.platformDeviceReplacementContracts).toEqual({
      list: {
        method: "GET",
        path: "/platform/tenants/:tenantId/device-licensing/replacements",
        response: contracts.deviceReplacementListSchema,
      },
      preview: {
        method: "POST",
        path: "/platform/tenants/:tenantId/device-licensing/:deviceId/replacements/preview",
        status: 200,
        body: contracts.deviceReplacementPreviewRequestSchema,
        response: contracts.deviceReplacementPreviewSchema,
      },
      confirm: {
        method: "POST",
        path: "/platform/tenants/:tenantId/device-licensing/:deviceId/replacements/confirm",
        status: 200,
        body: contracts.deviceReplacementConfirmSchema,
        response: contracts.deviceReplacementReceiptSchema,
      },
      cancel: {
        method: "POST",
        path: "/platform/tenants/:tenantId/device-licensing/replacements/:preparationId/cancel",
        status: 200,
        body: contracts.deviceReplacementCancelSchema,
        response: contracts.deviceReplacementReceiptSchema,
      },
    });
  });
});
