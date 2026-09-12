import type { LegalDocumentCode, LegalRevision } from "../types.js";

/**
 * Releases published before the page header was corrected.
 *
 * The header used to set the wordmark on the baseline beside the symbol, so it
 * read as having slipped below the mark. Correcting it changes the bytes of
 * every rendered file, and `artifacts.json` publishes a sha256 per release —
 * a revision is expected to pin its bytes. Re-rendering these in place would
 * make a reader's saved copy stop verifying against the revision it came from.
 *
 * So they keep the header they were issued with, and each one picks up the
 * correction at its next reissue, when its revision moves anyway. Anything
 * issued from now on is centred. The list shrinks on its own: a reissue lands
 * under a new revision, which is not in here.
 */
const LEGACY_WORDMARK_RELEASES: ReadonlySet<string> = new Set([
  "MKR-BRD-01/2026.08/01",
  "MKR-DPA-01/2026.08/01",
  "MKR-INS-01/2026.09/01",
  "MKR-INS-02/2026.09/01",
  "MKR-INS-03/2026.09/01",
  "MKR-INS-04/2026.08/02",
  "MKR-INS-05/2026.09/01",
  "MKR-INS-06/2026.09/01",
  "MKR-INS-07/2026.08/03",
  "MKR-INS-08/2026.09/01",
  "MKR-INS-09/2026.09/03",
  "MKR-INS-10/2026.09/01",
  "MKR-INS-11/2026.09/01",
  "MKR-PD-01/2026.08/01",
  "MKR-PD-02/2026.08/01",
]);

export function isLegacyWordmarkRelease(code: LegalDocumentCode, revision: LegalRevision): boolean {
  return LEGACY_WORDMARK_RELEASES.has(`${code}/${revision}`);
}

/** Exposed so a test can check the list names releases that actually exist. */
export function legacyWordmarkReleaseKeys(): readonly string[] {
  return [...LEGACY_WORDMARK_RELEASES];
}
