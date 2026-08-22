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
  LEGAL_DOCUMENT_KIND_BY_CODE,
  LEGAL_DOCUMENTS,
  LEGAL_RELEASES,
  findLegalDocument,
  findLegalRelease,
  legalDocumentKind,
  legalReleaseLocales,
  requireLegalContent,
  validateLegalRegistry,
} from "./registry.js";
export type {
  LegalBlock,
  LegalDocumentCode,
  LegalDocumentKind,
  LegalDocumentLocaleContent,
  LegalDocumentRelease,
  LegalDocumentSource,
  LegalDocumentStatus,
  LegalLocale,
  LegalOperatorProfile,
  LegalOperatorProfileId,
} from "./types.js";
