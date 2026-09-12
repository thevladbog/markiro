import { describe, expect, it } from "vitest";
import * as c from "../src/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const command = {
  kind: "temporary",
  effects: [{ key: "chzIntegration", featureEnabled: true }],
  operationIds: ["nk.lookup.v1"],
  startsAt: "2026-09-11T00:00:00.000Z",
  endsAt: "2026-10-11T00:00:00.000Z",
  reason: "Pilot",
  decisionReference: "PILOT-1",
  requestId: id,
};

describe("P1 entitlement registry and source boundaries", () => {
  it("exposes the approved closed registry without future regulator submission", () => {
    expect(c.ENTITLEMENT_FEATURE_KEYS).toEqual([
      "labelEditor",
      "publicApi",
      "pallets",
      "chzIntegration",
      "inventory",
      "commerceMl",
      "handheld",
    ]);
    expect(c.ENTITLEMENT_QUOTA_KEYS).toEqual(["lines", "stations", "kiosks", "cabinetUsers"]);
    expect(c.P1_FEATURE_KEYS).toEqual(["chzIntegration", "inventory", "commerceMl", "handheld"]);
    expect(c.ENTITLEMENT_OPERATIONS["nk.lookup.v1"].features).toEqual(["chzIntegration"]);
    expect(c.ENTITLEMENT_OPERATIONS["chz.export.create.v1"].features).toEqual([
      "inventory",
      "chzIntegration",
    ]);
    expect(c.entitlementOperationIdSchema.safeParse("chz.submit.v1").success).toBe(false);
    expect(c.ENTITLEMENT_OPERATIONS["chz.export.poll.v1"].class).toBe("continuation");
    expect(c.ENTITLEMENT_OPERATIONS["chz.export.receipt.v1"].class).toBe("stored_read");
    expect(c.ENTITLEMENT_OPERATIONS["inventory.task.create.v1"].features).toEqual(["inventory"]);
    expect(c.ENTITLEMENT_OPERATIONS["inventory.task.start.v1"].features).toEqual(["inventory"]);
    expect(c.ENTITLEMENT_OPERATIONS["inventory.task.start.v1"].class).toBe("new_work");
    expect(c.ENTITLEMENT_OPERATIONS["inventory.task.start.v1"].coverage).toBe("p1b_adapter");
    expect(c.ENTITLEMENT_REGISTRY_VERSION).toBe("p1b.v1");
    expect(c.ENTITLEMENT_OPERATIONS["handheld.work.start.v1"].coverage).toBe("deferred");
    expect(c.ENTITLEMENT_OPERATIONS["commerceMl.exchange.v1"].coverage).toBe("p1b_adapter");
  });
  it("requires positive bounded effects, explicit unique operations and finite temporary intervals", () => {
    expect(c.entitlementSourceCommandSchema.parse(command)).toEqual(command);
    for (const patch of [
      { endsAt: null },
      { endsAt: command.startsAt },
      { endsAt: "infinity" },
      { reason: " " },
      { decisionReference: "" },
      { requestId: "request" },
      { operationIds: [] },
      { operationIds: ["nk.lookup.v1", "nk.lookup.v1"] },
      { operationIds: ["arbitrary.recovery.v1"] },
      { recovery: true },
      { effects: [{ key: "stations", quotaIncrement: -1 }] },
      { effects: [{ key: "handheld", featureEnabled: false }] },
      { effects: [...command.effects, ...command.effects] },
    ])
      expect(c.entitlementSourceCommandSchema.safeParse({ ...command, ...patch }).success).toBe(
        false,
      );
  });
  it("limits compatibility to new module grants and the declared operation modules", () => {
    expect(
      c.entitlementSourceCommandSchema.safeParse({
        ...command,
        kind: "compatibility",
        endsAt: null,
      }).success,
    ).toBe(true);
    for (const effects of [
      [{ key: "stations", quotaIncrement: 1 }],
      [{ key: "publicApi", featureEnabled: true }],
      [{ key: "inventory", featureEnabled: true }],
    ]) {
      expect(
        c.entitlementSourceCommandSchema.safeParse({ ...command, kind: "compatibility", effects })
          .success,
      ).toBe(false);
    }
  });
  it("separates preview intent and immutable confirmation from editable commands", () => {
    expect(
      c.entitlementSourcePreviewRequestSchema.safeParse({ intent: "prepare", command }).success,
    ).toBe(true);
    expect(
      c.entitlementSourcePreviewRequestSchema.safeParse({
        intent: "revoke",
        sourceId: id,
        reason: "End pilot",
        decisionReference: "PILOT-2",
        requestId: id,
      }).success,
    ).toBe(true);
    expect(c.entitlementSourceConfirmSchema.parse({ previewId: id, requestId: id })).toEqual({
      previewId: id,
      requestId: id,
    });
    expect(
      c.entitlementSourceConfirmSchema.safeParse({
        previewId: id,
        requestId: id,
        effects: command.effects,
      }).success,
    ).toBe(false);
  });
  it("keeps a safe projection without internal reasons or fabricated historical usage", () => {
    const quota = { limit: 2, used: 1, remaining: 1 };
    const quotas = {
      lines: quota,
      stations: quota,
      kiosks: { limit: 0, used: 0, remaining: 0 },
      cabinetUsers: { limit: null, used: 3, remaining: null },
    };
    const source = {
      id,
      kind: "temporary",
      versionId: id,
      startsAt: command.startsAt,
      endsAt: command.endsAt,
      prepared: true,
      effects: command.effects,
      operationIds: command.operationIds,
    };
    const snapshot = {
      version: 1,
      tenantId: "tenant-a",
      asOf: command.startsAt,
      countedAt: command.startsAt,
      revision: "9007199254740993",
      usageRevision: "4",
      nextChangeAt: command.endsAt,
      current: {
        access: "unmanaged",
        writeAllowed: true,
        subscription: null,
        quotas,
        features: { labelEditor: true, publicApi: false, pallets: false },
      },
      candidate: {
        quotas,
        features: {
          labelEditor: true,
          publicApi: false,
          pallets: false,
          chzIntegration: null,
          inventory: false,
          commerceMl: false,
          handheld: null,
        },
      },
      sources: [source],
      readiness: { mode: "shadow", reasons: ["mapping_required"] },
      historical: { available: false },
      connectivity: { observedAt: command.startsAt, chz: "unknown", nationalCatalog: "unknown" },
    };
    expect(c.entitlementSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    const confirmation = {
      previewId: id,
      requestId: id,
      sourceId: id,
      confirmedAt: command.startsAt,
      after: snapshot,
    };
    expect(c.entitlementSourceConfirmationSchema.parse(confirmation)).toEqual(confirmation);
    expect(
      c.entitlementSourceConfirmationSchema.safeParse({ ...confirmation, effects: command.effects })
        .success,
    ).toBe(false);
    expect(
      c.entitlementSourceListSchema.safeParse({
        snapshot,
        detailsVisible: false,
        sourceDetails: [],
        decisionReference: "private",
      }).success,
    ).toBe(false);

    expect(
      c.entitlementSnapshotV1Schema.safeParse({
        ...snapshot,
        current: { ...snapshot.current, features: snapshot.candidate.features },
      }).success,
    ).toBe(false);
    expect(
      c.entitlementSnapshotV1Schema.safeParse({ ...snapshot, historical: { available: true } })
        .success,
    ).toBe(false);
    expect(
      c.entitlementSnapshotV1Schema.safeParse({
        ...snapshot,
        sources: [{ ...source, reason: "internal" }],
      }).success,
    ).toBe(false);
    expect(
      c.entitlementSnapshotV1Schema.safeParse({
        ...snapshot,
        candidate: {
          ...snapshot.candidate,
          quotas: { ...quotas, lines: { limit: 2, used: 1, remaining: 2 } },
        },
      }).success,
    ).toBe(false);
    expect(
      c.platformEntitlementSourceSchema.safeParse({
        ...source,
        tenantId: "tenant-a",
        subscriptionId: id,
        version: 1,
        reason: "Pilot",
        decisionReference: "PILOT-1",
        requestId: id,
        createdByPlatformUserId: "user-a",
        createdAt: command.startsAt,
        revokedAt: null,
        revokedByPlatformUserId: null,
      }).success,
    ).toBe(true);
  });
});

it("preserves base-plan provenance including unlimited and false without additive grants", () => {
  const source = {
    id,
    kind: "plan",
    versionId: id,
    startsAt: command.startsAt,
    endsAt: null,
    prepared: false,
    effects: [],
    operationIds: [],
    plan: {
      quotas: { lines: null, stations: 0, kiosks: 0, cabinetUsers: 2 },
      features: {
        labelEditor: false,
        publicApi: false,
        pallets: false,
        chzIntegration: null,
        inventory: null,
        commerceMl: null,
        handheld: null,
      },
    },
  };
  expect(c.entitlementSourceSchema.parse(source)).toEqual(source);
  const { plan: _plan, ...missing } = source;
  void _plan;
  expect(c.entitlementSourceSchema.safeParse(missing).success).toBe(false);
  expect(c.entitlementSourceSchema.safeParse({ ...source, kind: "addon" }).success).toBe(false);
  expect(
    c.entitlementSourceSchema.safeParse({ ...missing, kind: "temporary", prepared: false }).success,
  ).toBe(false);
});

it("allows compatibility modules to compose with an explicit plan for the same operation", () => {
  const grant = { ...command, kind: "compatibility", operationIds: ["chz.export.create.v1"] };
  expect(c.entitlementSourceCommandSchema.parse(grant)).toEqual(grant);
  expect(
    c.entitlementSourceCommandSchema.safeParse({
      ...grant,
      operationIds: ["inventory.file.create.v1"],
    }).success,
  ).toBe(false);
});

it("separates deferred adapters from runtime release gates and non-cabinet authorization", () => {
  expect(c.ENTITLEMENT_OPERATIONS["nk.lookup.v1"]).toMatchObject({
    authorization: "cabinet",
    capability: "operations.read",
    releaseEligibility: "national_catalog_operation_policy",
  });
  expect(c.ENTITLEMENT_OPERATIONS["commerceMl.exchange.v1"]).toMatchObject({
    authorization: "exchange_session",
    capability: null,
    implementationStage: "p1b",
    releaseEligibility: "existing_operation_policy",
  });
  expect(c.ENTITLEMENT_OPERATIONS["handheld.work.start.v1"]).toMatchObject({
    authorization: "station_device",
    capability: null,
  });
  expect(c.ENTITLEMENT_OPERATIONS["publicApi.request.v1"]).toMatchObject({
    authorization: "api_key_scope",
    capability: null,
  });
  expect(c.ENTITLEMENT_OPERATIONS["chz.export.create.v1"].releaseEligibility).toBe(
    "chz_filtered_cis_report_policy",
  );
});

it.each([
  "invalid",
  "1.5",
  "",
  "-1",
  "+1",
  "01",
  " 1",
  "1 ",
  "0x10",
  "1e3",
  "9223372036854775808",
  "99999999999999999999",
])("rejects malformed or overflowing revision %j without throwing", (value) => {
  expect(() => c.entitlementRevisionSchema.safeParse(value)).not.toThrow();
  expect(c.entitlementRevisionSchema.safeParse(value).success).toBe(false);
});
it.each(["0", "1", "9007199254740993", "9223372036854775807"])(
  "preserves canonical revision %s exactly at bigint boundaries",
  (value) => expect(c.entitlementRevisionSchema.parse(value)).toBe(value),
);

it("bounds effective addon contributions separately from per-unit source commands", () => {
  expect(
    c.entitlementProjectionEffectSchema.parse({ key: "stations", quotaIncrement: 3_000_000_000 }),
  ).toEqual({ key: "stations", quotaIncrement: 3_000_000_000 });
  expect(
    c.entitlementProjectionEffectSchema.safeParse({
      key: "stations",
      quotaIncrement: Number.MAX_SAFE_INTEGER + 1,
    }).success,
  ).toBe(false);
  expect(
    c.entitlementEffectSchema.safeParse({ key: "stations", quotaIncrement: 3_000_000_000 }).success,
  ).toBe(false);
});

it("classifies template/pallet online owners without granting deferred public or handheld work", () => {
  expect(c.ENTITLEMENT_OPERATIONS["labelEditor.template.write.v1"].coverage).toBe("p1b_adapter");
  expect(c.ENTITLEMENT_OPERATIONS["pallets.shift.configure.v1"]).toMatchObject({
    authorization: "cabinet",
    capability: "operations.write",
    coverage: "p1b_adapter",
  });
  expect(c.ENTITLEMENT_OPERATIONS["pallets.shift.configure.station.v1"]).toMatchObject({
    authorization: "station_device",
    capability: null,
    class: "new_work",
    coverage: "p1b_adapter",
  });
  expect(c.ENTITLEMENT_OPERATIONS["pallets.shift.start.v1"]).toMatchObject({
    authorization: "cabinet_or_station_device",
    class: "new_work",
    coverage: "p1b_adapter",
  });
  expect(c.ENTITLEMENT_OPERATIONS["publicApi.request.v1"].coverage).toBe("deferred");
  expect(c.ENTITLEMENT_OPERATIONS["handheld.work.start.v1"].coverage).toBe("deferred");
});
