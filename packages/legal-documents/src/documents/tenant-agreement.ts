import type { LegalDocumentLocaleContent, LegalLocale } from "../types.js";
import { buildEnAgreementSections } from "./tenant-agreement-en.js";
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
  if (locale === "en") {
    return {
      locale: "en",
      title:
        "Agreement on granting the right to use the Markiro computer program, access to the service and performance of services and works",
      summary:
        "Draft of the standard Markiro agreement with a customer that is a legal entity or a sole proprietor: a simple (non-exclusive) licence, access to server-side functionality, and services and works under separate assignments. The agreement is not concluded until the bracketed fields are completed and the parties have executed it in an agreed manner.",
      sections: buildEnAgreementSections(fields),
    };
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
