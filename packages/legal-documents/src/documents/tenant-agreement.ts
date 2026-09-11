import type { LegalDocumentLocaleContent, LegalLocale } from "../types.js";
import type { TenantAgreementFields } from "./tenant-agreement-fields.js";
import { buildRuAgreementSections } from "./tenant-agreement-ru.js";

/**
 * Draft of the standard Markiro client agreement. This is not a registry
 * release: it has no landing route, no published artifact and no attestation
 * entry. Square-bracket fields must be completed and the commercial terms
 * agreed before the document is sent to a client.
 */
export function buildTenantAgreement(
  fields: TenantAgreementFields,
  locale: LegalLocale,
): LegalDocumentLocaleContent {
  if (locale !== "ru") {
    throw new Error("English tenant agreement is not available in this revision");
  }
  return {
    locale: "ru",
    title:
      "Договор о предоставлении права использования программы для ЭВМ «Маркиро», доступа к сервису и выполнении услуг и работ",
    summary:
      "Проект стандартного договора Маркиро с заказчиком-юридическим лицом или индивидуальным предпринимателем: простая (неисключительная) лицензия, доступ к серверной функциональности, а также услуги и работы по отдельным заданиям. Договор не считается заключённым, пока не заполнены поля в квадратных скобках и стороны не оформили его согласованным способом.",
    sections: buildRuAgreementSections(fields),
  };
}
