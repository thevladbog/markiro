import type { CaseLinkResult } from "@markiro/platform-contracts";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support.js";
import type { UsDatasetContext } from "../demo/us-dataset-contract.js";
import { prepareUsDatasetCases } from "../demo/us-dataset-cases-prepare.js";
import {
  caseDemoAuditIdentity,
  caseDemoCommandDigest,
  datasetCasesError,
  parseUsDatasetCasesResult,
} from "../demo/us-dataset-cases-contract.js";
import type { UsDatasetTransformationStores } from "../demo/us-dataset-transformation-verify.js";
import { linkPreparedDemoCasesInTransaction } from "./us-case-demo-content.js";

/** Internal entry: caller owns atomicity, rollback and a fresh whole-transaction retry. */
export async function linkDemoCasesInTransaction(
  tx: UsMasterDataTransaction,
  context: UsDatasetContext,
  datasetId: string,
  unitKey: string,
  requestId: string,
  stores: UsDatasetTransformationStores,
): Promise<CaseLinkResult> {
  const { input, intent, cases } = await prepareUsDatasetCases(
    tx,
    context,
    datasetId,
    unitKey,
    { mode: "application" },
    stores,
  );
  return linkPreparedDemoCasesInTransaction(
    tx,
    context,
    input,
    intent.operationKey,
    requestId,
    { digest: caseDemoCommandDigest(input), seed: caseDemoAuditIdentity(input) },
    cases.receipt ? parseUsDatasetCasesResult(cases.receipt.result).linked : null,
    (code, cause) => datasetCasesError(code, unitKey, cause),
  );
}
