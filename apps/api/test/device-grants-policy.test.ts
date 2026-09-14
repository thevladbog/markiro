import { describe, expect, it } from "vitest";
import { entitlementDigest } from "../src/subscriptions/entitlement-snapshot-reader";
import {
  computeGrantDeadlines,
  effectiveGrantPolicyOverlay,
  parseApprovedGrantPolicy,
  grantRolloutMode,
} from "../src/modules/device-grants/grant-policy";

const payload = {
  offlineGrant: {
    version: 1,
    maxOfflineMs: 100,
    maxCompletionMs: 200,
    taskBounds: {
      shift: { "shift.scan.v1": { maxEvents: 5, maxUnits: 4 } },
      inventoryCheck: { "inventory.scan.v1": { maxEvents: 5, maxUnits: 4 } },
      inventoryRepack: { "inventory.repack.v1": { maxEvents: 5, maxUnits: 4 } },
      pickup: { "pickup.complete.v1": { maxEvents: 1, maxUnits: 4, maxContainers: 2 } },
    },
  },
};
function row() {
  return {
    id: "policy-1",
    version: 3,
    status: "approved",
    payload,
    payloadHash: entitlementDigest(payload),
    decisionReference: "test-only-approval",
    approvedAt: new Date(1),
    approvedByPlatformUserId: "approver",
  };
}
describe("approved finite offline authority", () => {
  it("binds exact approved registry identity, version, hash and actor", () => {
    const source = row();
    expect(parseApprovedGrantPolicy(source)).toMatchObject({
      revision: `policy-1:3:${source.payloadHash}`,
      approvalReference: "test-only-approval",
      approvedByPlatformUserId: "approver",
      maxOfflineMs: 100,
      maxCompletionMs: 200,
    });
  });
  it.each([
    { status: "draft" },
    { approvedAt: null },
    { approvedAt: new Date(NaN) },
    { approvedByPlatformUserId: null },
    { decisionReference: " " },
    { payloadHash: "a".repeat(64) },
    { version: 0 },
  ])("rejects incomplete or corrupted approval %j", (change) => {
    expect(parseApprovedGrantPolicy({ ...row(), ...change })).toBeNull();
  });
  it.each([
    {},
    { offlineHours: 24 },
    { offlineGrant: { ...payload.offlineGrant, version: 2 } },
    { offlineGrant: { ...payload.offlineGrant, maxOfflineMs: 0 } },
    { offlineGrant: { ...payload.offlineGrant, maxCompletionMs: Infinity } },
  ])("does not invent authority for unsupported payload %j", (invalid) => {
    expect(
      parseApprovedGrantPolicy({
        ...row(),
        payload: invalid,
        payloadHash: entitlementDigest(invalid),
      }),
    ).toBeNull();
  });
  it("keeps explicit zero budgets as exhausted and missing task bounds absent", () => {
    const value = {
      offlineGrant: {
        ...payload.offlineGrant,
        taskBounds: { shift: { "shift.scan.v1": { maxEvents: 0, maxUnits: 0 } } },
      },
    };
    expect(
      parseApprovedGrantPolicy({ ...row(), payload: value, payloadHash: entitlementDigest(value) })
        ?.taskBounds,
    ).toEqual({ shift: { "shift.scan.v1": { maxEvents: 0, maxUnits: 0 } } });
  });
  it("does not configure absent policy", () => {
    expect(computeGrantDeadlines({ now: 1000, policy: null, entitlementBoundary: 2000 })).toEqual({
      status: "denied",
      reason: "policy_not_configured",
    });
  });
  it.each([null, NaN, Infinity, 1000, 999])(
    "rejects unproven or elapsed boundary %s",
    (boundary) => {
      expect(
        computeGrantDeadlines({
          now: 1000,
          policy: parseApprovedGrantPolicy(row()),
          entitlementBoundary: boundary,
        }),
      ).toEqual({ status: "denied", reason: "facts_unknown" });
    },
  );
  it("clips new starts to the earlier finite horizon with separate bounded completion", () => {
    expect(
      computeGrantDeadlines({
        now: 1000,
        policy: parseApprovedGrantPolicy(row()),
        entitlementBoundary: 1050,
      }),
    ).toEqual({ status: "ready", startNotAfter: 1050, completeNotAfter: 1200 });
    expect(
      computeGrantDeadlines({
        now: 1000,
        policy: parseApprovedGrantPolicy(row()),
        entitlementBoundary: 2000,
      }),
    ).toEqual({ status: "ready", startNotAfter: 1100, completeNotAfter: 1200 });
  });
});

describe("explicit server-owned rollout", () => {
  const deviceId = "018f7bd1-4420-4b13-9f77-89f3a5374763";
  it("defaults absent policy and absent rollout to observation", () => {
    expect(grantRolloutMode(null, deviceId)).toBe("observe");
    expect(grantRolloutMode(parseApprovedGrantPolicy(row()), deviceId)).toBe("observe");
  });
  it("restricts strict mode to exact devices in a hash-verified approved decision", () => {
    const value = {
      offlineGrant: {
        ...payload.offlineGrant,
        rollout: {
          protocol: "offline-grants-v1",
          mode: "strict",
          deviceIds: [deviceId],
          decisionReference: "test-only-rollout",
        },
      },
    };
    const approved = parseApprovedGrantPolicy({
      ...row(),
      payload: value,
      payloadHash: entitlementDigest(value),
    });
    expect(approved).not.toBeNull();
    expect(grantRolloutMode(approved, deviceId)).toBe("strict");
    expect(grantRolloutMode(approved, "another-device")).toBe("observe");
    expect(parseApprovedGrantPolicy({ ...row(), payload: value })).toBeNull();
    for (const patch of [
      { protocol: "unknown" },
      { decisionReference: " " },
      { deviceIds: [] },
      { deviceIds: [deviceId, deviceId] },
    ]) {
      const invalid = {
        offlineGrant: {
          ...value.offlineGrant,
          rollout: { ...value.offlineGrant.rollout, ...patch },
        },
      };
      expect(
        parseApprovedGrantPolicy({
          ...row(),
          payload: invalid,
          payloadHash: entitlementDigest(invalid),
        }),
      ).toBeNull();
    }
  });

  it("accepts only an exact device overlay that preserves base limits", () => {
    const base = parseApprovedGrantPolicy(row())!;
    const rolloutPayload = {
      offlineGrant: {
        ...payload.offlineGrant,
        rollout: {
          protocol: "offline-grants-v1" as const,
          mode: "strict" as const,
          deviceIds: [deviceId],
          decisionReference: "approved-pilot",
        },
      },
    };
    const rollout = parseApprovedGrantPolicy({
      ...row(),
      id: "policy-2",
      version: 4,
      payload: rolloutPayload,
      payloadHash: entitlementDigest(rolloutPayload),
    })!;
    expect(effectiveGrantPolicyOverlay(base, rollout, deviceId)).toBe(rollout);
    expect(effectiveGrantPolicyOverlay(base, rollout, "another-device")).toBe(base);
    expect(effectiveGrantPolicyOverlay(base, { ...rollout, maxOfflineMs: 101 }, deviceId)).toBe(
      base,
    );
    expect(
      effectiveGrantPolicyOverlay(base, { ...rollout, taskBounds: { pickup: {} } }, deviceId),
    ).toBe(base);
    const observe = {
      ...rollout,
      id: "policy-3",
      rollout: { ...rollout.rollout!, mode: "observe" as const },
    };
    expect(effectiveGrantPolicyOverlay(base, observe, deviceId, "observe")).toBe(observe);
    expect(effectiveGrantPolicyOverlay(base, observe, deviceId)).toBe(base);
  });
});
