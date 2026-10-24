import { createHash } from "node:crypto";
import {
  deriveHistoryPlan,
  isReservedHistoryVersion,
  releaseHistoryEvidenceSchema,
  historyCanonical,
} from "../../packages/platform-contracts/dist/release-history.js";
export { isReservedHistoryVersion };
export { historyCanonical };
export function buildHistoryPlan(input) {
  const evidence = releaseHistoryEvidenceSchema.parse(input);
  return {
    ...deriveHistoryPlan(evidence),
    evidenceSha256: createHash("sha256").update(historyCanonical(evidence)).digest("hex"),
  };
}

/** Trusted protected operator entry, not a remote route or unrestricted SQL CLI. */
export async function applyHistoryPlan(evidence, options, admission) {
  const { createRequire } = await import("node:module"),
    require = createRequire(import.meta.url);
  const {
    CatalogHistoryOperator,
  } = require("../../apps/api/dist/modules/release-catalog/catalog-history.js");
  const {
    validateOperatorAdmission,
  } = require("../../apps/api/dist/modules/release-catalog/catalog-operator.js");
  const plan = buildHistoryPlan(evidence);
  const verify = async () => {
    const a = validateOperatorAdmission(admission, "history", plan.evidenceSha256, options.now());
    await options.authorize(a);
  };
  await verify();
  return new CatalogHistoryOperator({ ...options, authorize: verify }).apply(evidence, {
    epoch: admission.epoch,
    evidenceSha256: plan.evidenceSha256,
    actor: options.actor,
  });
}
