import {
  LEGAL_RELEASES,
  findLegalDocument,
  findLegalRelease,
  legalVerificationPath,
  type LegalDocumentCode,
  type LegalLocale,
} from "@markiro/legal-documents";

import type { PageMetadata } from "../lib/seo";
import type { SearchPageRecord } from "./pages";

const SOCIAL_IMAGE = "/og-markiro.jpg";
const SOCIAL_IMAGE_ALT = {
  ru: "Маркиро — юридические документы и сведения об обработке данных",
  en: "Markiro legal documents and personal-data information",
} as const;

const DESCRIPTION_BY_CODE = {
  "MKR-PD-01": {
    ru: "Политика Маркиро об обработке персональных данных на сайте, в форме демонстрации и внутри тенантов.",
    en: "Markiro personal-data processing policy for the website, demonstration requests, and tenant data.",
  },
  "MKR-PD-02": {
    ru: "Условия согласия на обработку данных, передаваемых через форму запроса демонстрации Маркиро.",
    en: "Consent terms for personal data submitted through the Markiro demonstration-request form.",
  },
  "MKR-DPA-01": {
    ru: "Шаблон поручения, разделяющий обязанности тенанта-оператора и Маркиро как обработчика данных.",
    en: "Instruction template separating tenant-controller and Markiro processor responsibilities.",
  },
  "MKR-BRD-01": {
    ru: "Правила использования компактного фирменного бланка и контроля версии документа Маркиро.",
    en: "Use and document-control rules for the compact Markiro branded letterhead.",
  },
} as const satisfies Record<LegalDocumentCode, Record<LegalLocale, string>>;

export interface LegalDocumentPageDefinition {
  readonly metadata: PageMetadata;
  readonly code: LegalDocumentCode;
  readonly locale: LegalLocale;
}

export function getLegalDocumentPage(
  code: LegalDocumentCode,
  locale: LegalLocale,
): LegalDocumentPageDefinition {
  const release = findLegalRelease(code);
  const source = findLegalDocument(code);
  const content = source.content[locale];
  return {
    code,
    locale,
    metadata: {
      path: release.routes[locale],
      alternatePath: release.routes[locale === "ru" ? "en" : "ru"],
      locale,
      title: `${content.title} — ${locale === "ru" ? "Маркиро" : "Markiro"}`,
      description: DESCRIPTION_BY_CODE[code][locale],
      socialImage: SOCIAL_IMAGE,
      socialImageAlt: SOCIAL_IMAGE_ALT[locale],
    },
  };
}

export function getLegalRegistryPage(locale: LegalLocale): PageMetadata {
  return {
    path: locale === "ru" ? "/legal/" : "/en/legal/",
    alternatePath: locale === "ru" ? "/en/legal/" : "/legal/",
    locale,
    title: locale === "ru" ? "Юридические документы Маркиро" : "Markiro Legal Documents",
    description:
      locale === "ru"
        ? "Публичный реестр действующих политик, согласий и шаблонов Маркиро с кодами, редакциями и датами вступления в силу."
        : "Public registry of active Markiro policies, consents, and templates with codes, revisions, and effective dates.",
    socialImage: SOCIAL_IMAGE,
    socialImageAlt: SOCIAL_IMAGE_ALT[locale],
  };
}

export const ACTIVE_LEGAL_RELEASES = LEGAL_RELEASES.filter(({ status }) => status === "active");

export const LEGAL_SEARCH_PAGES: readonly SearchPageRecord[] = [
  ...(["ru", "en"] as const).map((locale) => {
    const metadata = getLegalRegistryPage(locale);
    return {
      path: metadata.path,
      alternatePath: metadata.alternatePath,
      locale,
      navigationLabel: locale === "ru" ? "Юридические документы" : "Legal documents",
      description: metadata.description,
      lastModified: "2026-08-15" as const,
    };
  }),
  ...ACTIVE_LEGAL_RELEASES.flatMap((release) =>
    (["ru", "en"] as const).map((locale) => {
      const page = getLegalDocumentPage(release.code, locale);
      return {
        path: page.metadata.path,
        alternatePath: page.metadata.alternatePath,
        locale,
        navigationLabel: findLegalDocument(release.code).content[locale].title,
        description: page.metadata.description,
        lastModified: release.effectiveDate,
      };
    }),
  ),
  ...ACTIVE_LEGAL_RELEASES.map((release) => ({
    path: legalVerificationPath(release),
    alternatePath: legalVerificationPath(release),
    locale: "ru" as const,
    navigationLabel: `${release.code} ${release.revision} — проверка / verification`,
    description: `Проверка опубликованной редакции ${release.code} и её SHA-256. Document revision verification.`,
    lastModified: release.effectiveDate,
  })),
];
