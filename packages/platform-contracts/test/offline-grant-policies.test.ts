import { describe, expect, it } from "vitest";
import {
  createOfflineGrantPolicySchema,
  offlineGrantPolicySchema,
} from "../src/offline-grant-policies.js";

describe("offline grant lifecycle policy contracts", () => {
  const offlineGrant = {
    version: 1 as const,
    maxOfflineMs: 8 * 60 * 60 * 1_000,
    maxCompletionMs: 24 * 60 * 60 * 1_000,
    taskBounds: {
      inventoryCheck: {
        "inventory.scan.v1": { maxEvents: 5_000, maxUnits: 5_000 },
        "inventory.close.v1": { maxEvents: 1 },
      },
    },
  };

  it("accepts a finite observe-ready policy without selecting a strict cohort", () => {
    expect(
      createOfflineGrantPolicySchema.parse({
        policyKey: "factory-standard",
        version: 1,
        offlineGrant,
      }),
    ).toEqual({ policyKey: "factory-standard", version: 1, offlineGrant });
  });

  it("rejects unknown events, unbounded durations and an empty rollout cohort", () => {
    expect(
      offlineGrantPolicySchema.safeParse({
        ...offlineGrant,
        taskBounds: { inventoryCheck: { "inventory.unknown.v1": { maxEvents: 1 } } },
      }).success,
    ).toBe(false);
    expect(offlineGrantPolicySchema.safeParse({ ...offlineGrant, maxOfflineMs: 0 }).success).toBe(
      false,
    );
    expect(
      offlineGrantPolicySchema.safeParse({
        ...offlineGrant,
        rollout: {
          protocol: "offline-grants-v1",
          mode: "strict",
          deviceIds: [],
          decisionReference: "PILOT-1",
        },
      }).success,
    ).toBe(false);
  });
});
