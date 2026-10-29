import {
  LEGAL_RELEASES,
  findLegalDocument,
  findLegalRelease,
  legalReleaseLocales,
  legalVerificationPath,
  requireLegalContent,
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
  "MKR-INS-01": {
    ru: "Печатная инструкция оператора станции Маркиро Автоном: вход по бейджу или табельному номеру и PIN, выбор смены линии, создание смены на станции и начало работы.",
    en: "Printable Markiro Autonom station operator instruction: sign-in with a badge or a personnel number and PIN, choosing a shift of the line, creating a shift on the station, and starting work.",
  },
  "MKR-INS-02": {
    ru: "Печатная инструкция оператора Маркиро Автоном: сигналы сканирования, закрытие коробов и паллет, проверка этикетки, работа без связи с хостом, очередь отправки и закрытие смены.",
    en: "Printable Markiro Autonom operator instruction: scan signals, closing boxes and pallets, the label check, working without the host connection, the send queue, and closing the shift.",
  },
  "MKR-INS-03": {
    ru: "Печатная инструкция оператора Маркиро Автоном для нештатных ситуаций: снятие кодов из короба, перепечатка этикетки, расформирование короба и паллеты, сбой печати и повторная печать этикеток.",
    en: "Printable Markiro Autonom operator instruction for exceptions: removing codes from a box, label reprint, box and pallet disassembly, print failures, and reprinting labels of any shift.",
  },
  "MKR-INS-04": {
    ru: "Печатная инструкция наладчика Маркиро Автоном: подключение станции к хосту в локальной сети по коду из офиса, выбор линии, принтеры, сканеры, звук, обновление и отвязка станции.",
    en: "Printable Markiro Autonom technician instruction: pairing the station with the host on the local network with a code from the office, choosing the line, printers, scanners, sound, updating and unpairing the station.",
  },
  "MKR-INS-08": {
    ru: "Печатная инструкция менеджера: производственная линия, станции на линии, планирование смены, режимы, агрегация и запуск.",
    en: "Printable manager instruction: production lines, stations on a line, shift planning, modes, aggregation, and launch.",
  },
  "MKR-INS-09": {
    ru: "Печатная инструкция менеджера: наблюдение за производством, закрытие смены из кабинета, данные после закрытия, отчёты для ГИС МТ и разбор их отказов.",
    en: "Printable manager instruction: production monitoring, closing a shift from the cabinet, late data, GIS MT reports, and resolving their failures.",
  },
  "MKR-INS-10": {
    ru: "Печатная инструкция менеджера: каталог продукции, карточка товара, ГТИН и его владелец, доведение карточки до статуса «Активен», фотография и вывод товара из оборота.",
    en: "Printable manager instruction: the product catalog, the product card, GTIN ownership, completing a card so it becomes active, the photo, and retiring a product.",
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
  const content = requireLegalContent(source, locale);
  const route = release.routes[locale];
  if (!route) throw new Error(`Legal route is not published for ${code}/${locale}`);
  return {
    code,
    locale,
    metadata: {
      path: route,
      alternatePath: release.routes[locale === "ru" ? "en" : "ru"] ?? route,
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

/** The public registry changes whenever a release is added, so its lastmod is the newest active release. */
export const LEGAL_REGISTRY_LAST_MODIFIED = ACTIVE_LEGAL_RELEASES.map(
  ({ effectiveDate }) => effectiveDate,
)
  .sort()
  .at(-1) as `${number}-${number}-${number}`;

export const LEGAL_SEARCH_PAGES: readonly SearchPageRecord[] = [
  ...(["ru", "en"] as const).map((locale) => {
    const metadata = getLegalRegistryPage(locale);
    return {
      path: metadata.path,
      alternatePath: metadata.alternatePath,
      locale,
      navigationLabel: locale === "ru" ? "Юридические документы" : "Legal documents",
      description: metadata.description,
      lastModified: LEGAL_REGISTRY_LAST_MODIFIED,
    };
  }),
  ...ACTIVE_LEGAL_RELEASES.flatMap((release) =>
    legalReleaseLocales(release.code).map((locale) => {
      const page = getLegalDocumentPage(release.code, locale);
      return {
        path: page.metadata.path,
        alternatePath: page.metadata.alternatePath,
        locale,
        navigationLabel: requireLegalContent(findLegalDocument(release.code), locale).title,
        description: page.metadata.description,
        lastModified: release.effectiveDate,
      };
    }),
  ),
];

/**
 * Verification routes stay published for printed Data Matrix codes but are
 * `noindex`: they are not search content and never enter the sitemap.
 */
export const LEGAL_VERIFICATION_ROUTES: readonly string[] = ACTIVE_LEGAL_RELEASES.map((release) =>
  legalVerificationPath(release),
);
