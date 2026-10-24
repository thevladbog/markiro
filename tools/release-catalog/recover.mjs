import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Build @markiro/api first. Reuse its canonical scanner and protected operator,
// never a second implementation which accepts weaker receipt semantics.
const operator = () => require("../../apps/api/dist/modules/release-catalog/catalog-operator.js");
export const validateRecoveryEvidence = (...args) => operator().validateRecoveryEvidence(...args);
export const recoveryEvidenceDigest = (...args) => operator().recoveryEvidenceDigest(...args);
export const recoveryPlanDigest = (...args) => operator().recoveryPlanDigest(...args);
export const applyCatalogRecovery = (...args) => operator().applyCatalogRecovery(...args);
