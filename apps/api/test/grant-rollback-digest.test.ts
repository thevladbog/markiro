import { describe, expect, it } from "vitest";
import type { GrantRollbackMember } from "@markiro/platform-contracts";
import { grantRollbackDigest } from "../src/modules/device-grants/grant-rollback-digest";

const member = (activationId: string, deviceId: string): GrantRollbackMember => ({
  activationId,
  activationPreparationId: "018f7bd1-4420-4b13-9f77-89f3a5374805",
  tenantId: "tenant-a",
  tenantName: "Factory A",
  subscriptionId: "018f7bd1-4420-4b13-9f77-89f3a5374806",
  deviceId,
  deviceKind: "station",
  deviceName: deviceId,
  credentialEpoch: 2,
  assignmentId: "018f7bd1-4420-4b13-9f77-89f3a5374808",
  configurationId: "018f7bd1-4420-4b13-9f77-89f3a5374809",
  basePolicyId: "018f7bd1-4420-4b13-9f77-89f3a5374810",
  strictPolicyId: "018f7bd1-4420-4b13-9f77-89f3a5374811",
  activatedAt: "2026-09-14T09:00:00.000Z",
});

describe("grant rollback digest", () => {
  it("is stable across selected activation order and changes on authority drift", () => {
    const a = member(
      "018f7bd1-4420-4b13-9f77-89f3a5374803",
      "018f7bd1-4420-4b13-9f77-89f3a5374807",
    );
    const b = member(
      "018f7bd1-4420-4b13-9f77-89f3a5374804",
      "018f7bd1-4420-4b13-9f77-89f3a5374817",
    );
    const base = {
      protocol: "offline-grants-rollback-v1" as const,
      basePolicyId: a.basePolicyId,
      basePolicyHash: "a".repeat(64),
      decisionReference: "CAB-RB",
      asOf: "2026-09-14T09:10:00.000Z",
    };
    expect(grantRollbackDigest({ ...base, members: [a, b] })).toBe(
      grantRollbackDigest({ ...base, members: [b, a] }),
    );
    expect(grantRollbackDigest({ ...base, members: [a, { ...b, credentialEpoch: 3 }] })).not.toBe(
      grantRollbackDigest({ ...base, members: [a, b] }),
    );
  });
});
