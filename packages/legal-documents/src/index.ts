export { OPERATOR_PROFILES } from "./operator.js";
export {
  formatLegalEffectiveDate,
  legalRevisionFileToken,
  legalVerificationPath,
  legalVerificationUrl,
  parseLegalRevision,
} from "./identity.js";
export type { LegalIdentity, LegalRevision, LegalRevisionParts } from "./identity.js";
export {
  CURRENT_DEMO_CONSENT_ID,
  LEGAL_DOCUMENTS,
  LEGAL_RELEASES,
  findLegalDocument,
  findLegalRelease,
  validateLegalRegistry,
} from "./registry.js";
export type {
  LegalBlock,
  LegalDocumentCode,
  LegalDocumentLocaleContent,
  LegalDocumentRelease,
  LegalDocumentSource,
  LegalDocumentStatus,
  LegalLocale,
  LegalOperatorProfile,
  LegalOperatorProfileId,
} from "./types.js";
