import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  entitlementEffectSchema,
  entitlementSourceSchema,
  entitlementSourceCommandSchema,
  type EntitlementSource,
} from "@markiro/platform-contracts";
import {
  projectEntitlements,
  evaluateEntitlementOperation,
} from "../src/subscriptions/entitlement-projection";
import type { EffectiveEntitlements } from "../src/subscriptions/entitlements.types";
const at = new Date("2026-09-11T10:00:00Z");
const current: EffectiveEntitlements = {
  tenantId: randomUUID(),
  access: "managed",
  subscription: {
    id: randomUUID(),
    planVersionId: randomUUID(),
    status: "active",
    startsAt: new Date("2026-09-01Z"),
    endsAt: new Date("2026-10-01Z"),
  },
  quotas: { lines: 0, stations: null, kiosks: 2, cabinetUsers: 3 },
  features: { labelEditor: false, publicApi: false, pallets: false },
};
const plan: EntitlementSource = {
  id: current.subscription!.id,
  versionId: current.subscription!.planVersionId,
  kind: "plan",
  prepared: false,
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2026-10-01T00:00:00.000Z",
  effects: [],
  operationIds: [],
  plan: {
    quotas: current.quotas,
    features: {
      ...current.features,
      chzIntegration: null,
      inventory: true,
      commerceMl: false,
      handheld: false,
    },
  },
};
const source = (overrides: Record<string, unknown> = {}): EntitlementSource =>
  entitlementSourceSchema.parse({
    id: randomUUID(),
    versionId: randomUUID(),
    kind: "temporary",
    prepared: true,
    startsAt: "2026-09-11T09:00:00.000Z",
    endsAt: "2026-09-11T11:00:00.000Z",
    effects: [{ key: "chzIntegration", featureEnabled: true }],
    operationIds: ["nk.lookup.v1"],
    ...overrides,
  });
const project = (
  sources: EntitlementSource[],
  access = current.access,
  mode: "all" | "managed_only" = "managed_only",
  time = at,
) =>
  projectEntitlements({
    current: {
      ...current,
      access,
      subscription: access === "unmanaged" ? null : current.subscription,
    },
    usage: { lines: 1, stations: 2, kiosks: 0, cabinetUsers: 1 },
    sources,
    at: time,
    enforcementMode: mode,
    revision: "1",
    usageRevision: "2",
    boundaries: [],
    readinessReasons: [],
  });
describe("entitlement projection", () => {
  it("keeps prepared rights separate and retains operation scope", () => {
    const snap = project([plan, source()]);
    expect(snap.current.features).toEqual(current.features);
    expect(snap.current.writeAllowed).toBe(true);
    expect(snap.candidate.features.chzIntegration).toBe(true);
    expect(evaluateEntitlementOperation(snap, "nk.lookup.v1").outcome).toBe("allow");
    expect(evaluateEntitlementOperation(snap, "chz.export.create.v1").outcome).toBe("unknown");
  });
  it("honors overlap and exact source/base interval boundaries", () => {
    const a = source();
    const b = source({ endsAt: "2026-09-11T12:00:00.000Z" });
    expect(
      project([plan, a, b], "managed", "managed_only", new Date(a.endsAt!)).candidate.features
        .chzIntegration,
    ).toBe(true);
    expect(
      project([plan, a], "managed", "managed_only", new Date(a.endsAt!)).candidate.features
        .chzIntegration,
    ).toBeNull();
    expect(project([plan, a], "read_only").candidate.features.chzIntegration).toBe(false);
    expect(project([plan, a]).nextChangeAt).toBe(a.endsAt);
  });
  it("distinguishes legacy unmanaged current write policy in both modes", () => {
    expect(project([], "unmanaged").current.writeAllowed).toBe(true);
    expect(project([], "unmanaged", "all").current.writeAllowed).toBe(false);
    expect(project([], "unmanaged").candidate.features.chzIntegration).toBeNull();
  });
  it("preserves zero/unlimited and safely sums large contributions", () => {
    const addon = source({
      kind: "addon",
      prepared: false,
      operationIds: [],
      effects: [
        { key: "lines", quotaIncrement: 3_000_000_000 },
        { key: "stations", quotaIncrement: 2 },
      ],
    });
    const snap = project([plan, addon]);
    expect(snap.candidate.quotas.lines).toEqual({
      limit: 3_000_000_000,
      used: 1,
      remaining: 2_999_999_999,
    });
    expect(snap.candidate.quotas.stations.limit).toBeNull();
    expect(project([plan]).candidate.quotas.lines.remaining).toBe(0);
    expect(
      entitlementEffectSchema.safeParse({ key: "lines", quotaIncrement: 3_000_000_000 }).success,
    ).toBe(false);
    expect(() =>
      source({
        kind: "addon",
        prepared: false,
        operationIds: [],
        effects: [{ key: "lines", quotaIncrement: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).toThrow();
    expect(() =>
      project([
        plan,
        source({
          kind: "addon",
          prepared: false,
          operationIds: [],
          effects: [{ key: "kiosks", quotaIncrement: Number.MAX_SAFE_INTEGER }],
        }),
      ]),
    ).toThrow();
  });
  it.each([
    ["labelEditor", "labelEditor.template.write.v1"],
    ["pallets", "pallets.shift.configure.v1"],
  ] as const)("retains explicit operation scope for %s temporary rights", (key, operationId) => {
    const command = entitlementSourceCommandSchema.parse({
      kind: "temporary",
      startsAt: at.toISOString(),
      endsAt: "2026-09-11T11:00:00.000Z",
      effects: [{ key, featureEnabled: true }],
      operationIds: [operationId],
      reason: "Pilot",
      decisionReference: "test",
      requestId: randomUUID(),
    });
    expect(command.operationIds).toEqual([operationId]);
    const snap = project([
      plan,
      source({
        kind: command.kind,
        startsAt: command.startsAt,
        endsAt: command.endsAt,
        effects: command.effects,
        operationIds: command.operationIds,
      }),
    ]);
    expect(evaluateEntitlementOperation(snap, operationId).outcome).toBe("allow");
    if (operationId === "pallets.shift.configure.v1") {
      for (const added of ["pallets.shift.configure.station.v1", "pallets.shift.start.v1"] as const)
        expect(evaluateEntitlementOperation(snap, added)).toEqual({
          outcome: "deny",
          reasonCodes: ["feature_not_included"],
        });
    }
  });
  it("preserves stored and continuation recovery when new work is commercially denied", () => {
    const snapshot = project([plan], "read_only");
    expect(evaluateEntitlementOperation(snapshot, "chz.export.create.v1")).toEqual({
      outcome: "deny",
      reasonCodes: ["subscription_read_only"],
    });
    for (const operationId of ["chz.export.poll.v1", "chz.export.receipt.v1"] as const)
      expect(evaluateEntitlementOperation(snapshot, operationId)).toEqual({
        outcome: "allow",
        reasonCodes: ["recovery_access_preserved"],
      });
  });
});
