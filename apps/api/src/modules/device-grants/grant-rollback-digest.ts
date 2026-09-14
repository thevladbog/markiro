import type { GrantRollbackMember } from "@markiro/platform-contracts";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";

export interface GrantRollbackDigestSnapshot {
  protocol: "offline-grants-rollback-v1";
  basePolicyId: string;
  basePolicyHash: string;
  members: GrantRollbackMember[];
  decisionReference: string;
  asOf: string;
}

export function canonicalRollbackMembers(
  members: readonly GrantRollbackMember[],
): GrantRollbackMember[] {
  return [...members].sort((left, right) =>
    left.activationId < right.activationId ? -1 : left.activationId > right.activationId ? 1 : 0,
  );
}

export function grantRollbackDigest(snapshot: GrantRollbackDigestSnapshot): string {
  return entitlementDigest({ ...snapshot, members: canonicalRollbackMembers(snapshot.members) });
}
