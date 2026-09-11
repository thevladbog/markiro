import type { TenantAgreementFields } from "./tenant-agreement-fields.js";
import { buildRuAgreementSections, type AgreementSection } from "./tenant-agreement-ru.js";

/**
 * The English sections of the standard Markiro client agreement.
 *
 * Translation lands section group by section group. Anything not yet
 * translated falls through to the Russian text, so the tree is always the
 * Russian tree with some sections substituted — same ids, same order, same
 * block shapes. That keeps `pairLocaleContent` satisfied from the first
 * commit, which is what makes the translation reviewable in pieces instead of
 * one unreadable leap.
 *
 * The four sections in `AGREEMENT_MONOLINGUAL_SECTION_IDS` fall through
 * permanently: they are Russian accounting forms.
 */
export function buildEnAgreementSections(
  fields: TenantAgreementFields,
): readonly AgreementSection[] {
  const translated = new Map<string, AgreementSection>();
  return buildRuAgreementSections(fields).map((section) => translated.get(section.id) ?? section);
}
