import { findLegalRelease } from "../registry.js";
import { legalRevisionFileToken, legalVerificationUrl, type LegalRevision } from "../identity.js";
import type { LegalDocumentCode, LegalLocale } from "../types.js";

export type LegalArtifactKind = "legal-pdf" | "template-docx";

export interface LegalArtifactRequest {
  readonly code: LegalDocumentCode;
  readonly revision: LegalRevision;
  readonly effectiveDate: string;
  readonly locale: LegalLocale;
  readonly kind: LegalArtifactKind;
  readonly verificationUrl: string;
}

const TEMPLATE_CODES = new Set<LegalDocumentCode>(["MKR-DPA-01", "MKR-BRD-01"]);

export function assertLegalArtifactRequest(input: LegalArtifactRequest): void {
  if (input.locale !== "ru" && input.locale !== "en") {
    throw new Error(`Invalid legal artifact locale: ${String(input.locale)}`);
  }
  if (input.kind !== "legal-pdf" && input.kind !== "template-docx") {
    throw new Error(`Invalid legal artifact kind: ${String(input.kind)}`);
  }

  let release;
  try {
    release = findLegalRelease(input.code, input.revision);
  } catch {
    throw new Error(
      `Legal artifact release is not current: ${String(input.code)}/${input.revision}`,
    );
  }
  if (
    release.status !== "active" ||
    release.revision !== input.revision ||
    release.effectiveDate !== input.effectiveDate
  ) {
    throw new Error(`Legal artifact release is not current: ${input.code}/${input.revision}`);
  }
  if (input.kind === "template-docx" && !TEMPLATE_CODES.has(input.code)) {
    throw new Error(`Legal artifact is not a downloadable template: ${input.code}`);
  }

  const expectedUrl = legalVerificationUrl(release);
  if (input.verificationUrl !== expectedUrl) {
    throw new Error(`Invalid legal artifact verification URL: ${input.verificationUrl}`);
  }
}

export function artifactFileName(input: LegalArtifactRequest): string {
  assertLegalArtifactRequest(input);
  const extension = input.kind === "template-docx" ? "docx" : "pdf";
  return `markiro_${input.code.toLowerCase()}_${legalRevisionFileToken(input.revision)}_${input.locale}.${extension}`;
}
