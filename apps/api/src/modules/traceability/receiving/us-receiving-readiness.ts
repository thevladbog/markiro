import type { ReceivingReadinessInput } from "@markiro/domain";
import type { ReceivingDraftRecord } from "@markiro/platform-contracts";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingReferenceContext } from "./us-receiving-reference-context";

export async function readReceivingReadiness(
  tx: UsMasterDataTransaction,
  tenantId: string,
  saved: ReceivingDraftRecord,
  profileCode: ReceivingReadinessInput["profileCode"],
) {
  return (await readReceivingReferenceContext(tx, tenantId, saved, profileCode)).readiness;
}
