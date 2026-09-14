import type { GrantActivationMember } from "@markiro/platform-contracts";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";

export interface GrantActivationDigestSnapshot extends Record<string, unknown> {
  protocol: "offline-grants-activation-v1";
  previewRequestId: string;
  previewDigest: string;
  basePolicy: {
    id: string;
    policyKey: string;
    version: number;
    payloadHash: string;
    revision: string;
  };
  members: GrantActivationMember[];
  decisionReference: string;
  asOf: string;
}

export function grantActivationPreparationDigest(snapshot: GrantActivationDigestSnapshot): string {
  return entitlementDigest(snapshot);
}
