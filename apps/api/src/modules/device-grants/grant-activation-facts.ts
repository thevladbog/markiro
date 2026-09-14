import { eq } from "drizzle-orm";
import { schema } from "@markiro/db";
import type { GrantActivationMember } from "@markiro/platform-contracts";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  readGrantReadinessFacts,
  type GrantReadinessFacts,
  type GrantReadinessSigningFacts,
  type GrantReadinessTargetPolicy,
} from "./grant-readiness-facts";
import { parseApprovedGrantPolicy, type ApprovedGrantPolicy } from "./grant-policy";

export interface GrantActivationPolicyFacts {
  id: string;
  policyKey: string;
  version: number;
  payloadHash: string;
  revision: string;
  payload: Record<string, unknown>;
  approved: ApprovedGrantPolicy;
}

export interface GrantActivationFacts {
  asOf: Date;
  basePolicy: GrantActivationPolicyFacts;
  rows: GrantReadinessFacts[];
}

export async function readGrantActivationFacts(
  tx: SubscriptionTransaction,
  input: { deviceIds: readonly string[]; policyId: string },
  asOf: Date,
  signing: GrantReadinessSigningFacts,
): Promise<GrantActivationFacts | null> {
  const [policyRow] = await tx
    .select()
    .from(schema.entitlementLifecyclePolicies)
    .where(eq(schema.entitlementLifecyclePolicies.id, input.policyId))
    .limit(1);
  const approved = parseApprovedGrantPolicy(policyRow);
  if (!policyRow || !approved) return null;
  const rows = await readGrantReadinessFacts(tx, asOf, { deviceIds: input.deviceIds }, signing);
  return {
    asOf,
    basePolicy: {
      id: policyRow.id,
      policyKey: policyRow.policyKey,
      version: policyRow.version,
      payloadHash: policyRow.payloadHash,
      revision: approved.revision,
      payload: policyRow.payload,
      approved,
    },
    rows,
  };
}

export function activationTargetPolicy(
  policy: GrantActivationPolicyFacts,
): GrantReadinessTargetPolicy {
  return { id: policy.id, revision: policy.revision, approved: true };
}

export function activationMembers(rows: readonly GrantReadinessFacts[]): GrantActivationMember[] {
  return rows.map((row) => {
    if (
      !row.subscriptionId ||
      !row.configuration ||
      !row.clientReport ||
      !row.verifiedGrant ||
      !row.currentKeysetRevision ||
      (row.deviceKind !== "kiosk" && !row.assignmentId)
    ) {
      throw new Error("Eligible activation facts are incomplete");
    }
    return {
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      subscriptionId: row.subscriptionId,
      deviceId: row.deviceId,
      deviceKind: row.deviceKind,
      deviceName: row.deviceName,
      credentialEpoch: row.credentialEpoch,
      assignmentId: row.assignmentId,
      configurationId: row.configuration.id,
      clientReportId: row.clientReport.id,
      verifiedGrantId: row.verifiedGrant.id,
      keysetRevision: row.currentKeysetRevision,
      entitlementRevision: row.entitlementRevision,
    };
  });
}
