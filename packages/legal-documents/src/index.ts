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
// The API renders agreements at runtime and resolves with node10, which
// cannot see subpath exports, so the draft renderer lives on the root entry.
// The registry-bound renderLegalDocx and artifactFileName stay off it.
export { renderLegalDocxBilingual, renderLegalDocxDraft } from "./artifacts/docx.js";
export type { LegalDocxAssets, LegalDocxBilingual, LegalDocxDraft } from "./artifacts/docx.js";
export { buildTenantAgreement } from "./documents/tenant-agreement.js";
export {
  AGREEMENT_MONOLINGUAL_SECTION_IDS,
  pairLocaleContent,
} from "./documents/tenant-agreement-bilingual.js";
export type { BilingualContent, BilingualSection } from "./documents/tenant-agreement-bilingual.js";
export { TENANT_AGREEMENT_PASSPORT_CONTENT } from "./documents/tenant-agreement-passport.js";
export {
  agreementDate,
  agreementField,
  isSoleProprietorOrIndividual,
} from "./documents/tenant-agreement-fields.js";
export type {
  AgreementSignatory,
  AgreementTerms,
  PartyKind,
  PartyRequisites,
  TenantAgreementFields,
} from "./documents/tenant-agreement-fields.js";
