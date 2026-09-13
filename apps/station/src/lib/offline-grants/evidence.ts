import { productLabelValueDigest } from "@markiro/domain";
import {
  grantEvidenceEnvelopeSchema,
  grantEvidenceReceiptSchema,
  type GrantEvidenceEnvelope,
  type GrantEvidenceReceipt,
} from "@markiro/platform-contracts";

/** A link to an already committed local decision, never a newly selected grant. */
export interface SavedStationEvidenceLink {
  pointer: string;
  grantId: string;
  compact: string | null;
}

export function buildStationEvidenceEnvelope(
  batchId: string,
  payload: unknown,
  links: readonly SavedStationEvidenceLink[],
): GrantEvidenceEnvelope {
  const grants = new Map<string, string>();
  const eventGrants: Record<string, string> = {};
  for (const link of links) {
    if (!link.compact) throw new Error("station original evidence grant unavailable");
    const previous = grants.get(link.grantId);
    if (previous !== undefined && previous !== link.compact)
      throw new Error("station original evidence grant identity conflict");
    if (eventGrants[link.pointer] !== undefined && eventGrants[link.pointer] !== link.grantId)
      throw new Error("station evidence event link conflict");
    grants.set(link.grantId, link.compact);
    eventGrants[link.pointer] = link.grantId;
  }
  return grantEvidenceEnvelopeSchema.parse({
    protocol: "offline-grants-v1",
    batchId,
    payloadDigest: productLabelValueDigest(payload),
    grants: [...new Set(grants.values())],
    eventGrants,
    payload,
  });
}

/** The existing native parser must still validate the result before acknowledging its queue. */
export function parseStationEvidenceReceipt(
  value: unknown,
  envelope: GrantEvidenceEnvelope,
): { receipt: GrantEvidenceReceipt; native: unknown } {
  const receipt = grantEvidenceReceiptSchema.parse(value);
  if (receipt.batchId !== envelope.batchId)
    throw new Error("station evidence receipt batch mismatch");
  const reconciliation = receipt.reconciliation;
  const applied =
    receipt.outcome !== "quarantined" &&
    reconciliation.status !== "not_applied" &&
    reconciliation.statusCode !== null &&
    reconciliation.statusCode >= 200 &&
    reconciliation.statusCode < 300;
  return { receipt, native: applied ? reconciliation.result : null };
}
