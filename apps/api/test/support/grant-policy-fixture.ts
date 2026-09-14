import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { entitlementDigest } from "../../src/subscriptions/entitlement-snapshot-reader";
import {
  parseApprovedGrantPolicy,
  type ApprovedGrantPolicy,
} from "../../src/modules/device-grants/grant-policy";
export async function seedGrantPolicy(
  db: Db,
  taskBounds: ApprovedGrantPolicy["taskBounds"],
  version?: { policyKey: string; version: number },
  rollout?: ApprovedGrantPolicy["rollout"],
) {
  const actor = randomUUID();
  await db
    .insert(schema.platformUsers)
    .values({ id: actor, name: "Test", email: `${actor}@example.invalid`, role: "platform_admin" });
  const payload = {
    offlineGrant: {
      version: 1,
      maxOfflineMs: 1000,
      maxCompletionMs: 2000,
      taskBounds,
      ...(rollout ? { rollout } : {}),
    },
  };
  const [row] = await db
    .insert(schema.entitlementLifecyclePolicies)
    .values({
      policyKey: version?.policyKey ?? `test-${actor}`,
      version: version?.version ?? 1,
      status: "approved",
      payload,
      payloadHash: entitlementDigest(payload),
      decisionReference: "test-only",
      approvedAt: new Date(),
      approvedByPlatformUserId: actor,
      createdByPlatformUserId: actor,
    })
    .returning();
  const policy = parseApprovedGrantPolicy(row);
  if (!policy) throw new Error("Invalid test policy");
  return policy;
}
