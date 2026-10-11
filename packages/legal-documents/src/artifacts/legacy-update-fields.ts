import type { LegalDocumentCode, LegalRevision } from "../types.js";

/**
 * Releases whose downloadable DOCX was published with `w:updateFields`.
 *
 * The setting makes Word open the file with "This document contains fields
 * that may refer to other files. Update the fields?". Nothing needs it: the
 * only field rendered is PAGE in the footer, which Word and LibreOffice
 * recalculate while paginating (ECMA-376 §17.15.1.94). Dropping it changes
 * the bytes of every DOCX, and `artifacts.json` publishes a sha256 per
 * release — a revision is expected to pin its bytes, as `legacy-wordmark.ts`
 * explains.
 *
 * Only the templates publish a DOCX; every other release publishes a PDF,
 * whose bytes are the same either way, so it is not listed. These keep the
 * setting until their next reissue moves the revision.
 */
const LEGACY_UPDATE_FIELDS_RELEASES: ReadonlySet<string> = new Set([
  "MKR-BRD-01/2026.08/01",
  "MKR-DPA-01/2026.08/01",
]);

export function isLegacyUpdateFieldsRelease(
  code: LegalDocumentCode,
  revision: LegalRevision,
): boolean {
  return LEGACY_UPDATE_FIELDS_RELEASES.has(`${code}/${revision}`);
}

/** Exposed so a test can check the list names releases that actually exist. */
export function legacyUpdateFieldsReleaseKeys(): readonly string[] {
  return [...LEGACY_UPDATE_FIELDS_RELEASES];
}
