import { schema } from "@markiro/db";
import type { EntitlementSnapshotV1 } from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../src/subscriptions/entitlements.types";
import { describe, expect, it } from "vitest";
import { grantPoolDenial } from "../src/modules/device-grants/grant-admission";

const tenantId = "tenant-a";
const deviceId = "11111111-1111-4111-8111-111111111111";
const assignmentId = "22222222-2222-4222-8222-222222222222";

function facts(replacementState: string, sourceState: "assigned" | "released" = "assigned") {
  const source = {
    id: deviceId,
    tenantId,
    apiKeyId: sourceState === "assigned" ? "credential-a" : null,
    pairedAt: null,
    lastSeenAt: null,
    revokedAt: sourceState === "released" ? new Date("2026-09-16T10:00:00.000Z") : null,
  };
  const assignment = {
    id: assignmentId,
    tenantId,
    deviceId,
    state: sourceState,
    revision: 1,
    releaseReason: sourceState === "released" ? "replacement_transferred" : null,
    releasedAt: sourceState === "released" ? source.revokedAt : null,
  };
  const pool = [{ device: source, assignment }];
  return {
    select(selection: Record<string, unknown> = {}) {
      const rows = "device" in selection ? pool : [{ state: replacementState }];
      const query = {
        where: async () => rows,
        leftJoin: () => ({ where: async () => rows }),
      };
      return {
        from: (table: unknown) =>
          table === schema.workingDeviceReplacementExecutions ? { where: async () => [] } : query,
      };
    },
  } as unknown as SubscriptionTransaction;
}

const snapshot = {
  candidate: { quotas: { stations: { limit: null } } },
} as unknown as EntitlementSnapshotV1;

describe("replacement grant admission", () => {
  it("keeps a prepared source eligible until a drain or execution projection exists", async () => {
    await expect(
      grantPoolDenial(
        facts("prepared"),
        { tenantId, deviceId, credentialEpoch: 1, kind: "station" },
        snapshot,
        {} as never,
        new Date("2026-09-16T10:00:00.000Z"),
      ),
    ).resolves.toBeNull();
  });

  it("denies a draining source and a source released by replacement", async () => {
    await expect(
      grantPoolDenial(
        facts("draining"),
        { tenantId, deviceId, credentialEpoch: 1, kind: "station" },
        snapshot,
        {} as never,
        new Date("2026-09-16T10:00:00.000Z"),
      ),
    ).resolves.toBe("not_entitled");
    await expect(
      grantPoolDenial(
        facts("prepared", "released"),
        { tenantId, deviceId, credentialEpoch: 1, kind: "station" },
        snapshot,
        {} as never,
        new Date("2026-09-16T10:00:00.000Z"),
      ),
    ).resolves.toBe("not_entitled");
  });
});
