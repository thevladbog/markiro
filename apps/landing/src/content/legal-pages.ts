import {
  LEGAL_RELEASES,
  findLegalDocument,
  findLegalRelease,
  legalReleaseLocales,
  legalDocumentKind,
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
    ru: "Печатная инструкция офиса Маркиро Автоном: линии и число устройств в смене, станции на линии, планирование смены, агрегация, паллеты и печать дубликата.",
    en: "Printable Markiro Autonom office instruction: lines and devices per shift, stations on a line, shift planning, aggregation, pallets, and duplicate printing.",
  },
  "MKR-INS-09": {
    ru: "Печатная инструкция офиса Маркиро Автоном: обзор производства, карточка смены, закрытие смены в офисе, данные после закрытия, выгрузки для ГИС МТ и 1С.",
    en: "Printable Markiro Autonom office instruction: the production overview, the shift card, closing a shift in the office, late data, and exports for GIS MT and 1C.",
  },
  "MKR-INS-10": {
    ru: "Печатная инструкция офиса Маркиро Автоном: товары, карточка товара, GTIN и его владелец, черновик и «Активен», фото, шаблоны по умолчанию и архив.",
    en: "Printable Markiro Autonom office instruction: products, the product card, GTIN ownership, draft and active, the photo, default templates, and archiving.",
  },
  "MKR-INS-12": {
    ru: "Печатная инструкция по установке Маркиро Автоном: роли компьютеров, постоянный адрес хоста, служба и порт, мастер первого запуска, лицензия, подключение устройств и обновление.",
    en: "Printable Markiro Autonom installation instruction: computer roles, the host's permanent address, the service and port, the first-start wizard, the license, pairing devices, and updates.",
  },
  "MKR-INS-13": {
    ru: "Печатная инструкция администратора Маркиро Автоном: автоматические копии хоста, копия по кнопке, вторая папка и Яндекс Диск, восстановление на том же или новом ПК и возобновление приёма данных станций.",
    en: "Printable Markiro Autonom administrator instruction: the host's automatic copies, a copy on request, the second folder and Yandex Disk, restoring on the same or a new PC, and resuming station data.",
  },
  "MKR-INS-14": {
    ru: "Печатная инструкция склада Маркиро Автоном: привязка ТСД к хосту, вход оператора, принтер, сборка паллеты из коробов, этикетка паллеты и работа без связи.",
    en: "Printable Markiro Autonom warehouse instruction: pairing the handheld with the host, operator sign-in, the printer, building a pallet from boxes, the pallet label, and offline work.",
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
  const instruction = legalDocumentKind(code) === "instruction";
  return {
    code,
    locale,
    metadata: {
      path: route,
      alternatePath: release.routes[locale === "ru" ? "en" : "ru"] ?? route,
      locale,
      title: `${content.title} — ${instruction ? (locale === "ru" ? "Маркиро Автоном" : "Markiro Autonom") : locale === "ru" ? "Маркиро" : "Markiro"}`,
      description: DESCRIPTION_BY_CODE[code][locale],
      socialImage: SOCIAL_IMAGE,
      socialImageAlt: instruction
        ? locale === "ru"
          ? "Маркиро Автоном — инструкции станции, офиса и ТСД"
          : "Markiro Autonom — station, office and handheld instructions"
        : SOCIAL_IMAGE_ALT[locale],
      ...(instruction
        ? {
            ogType: "article" as const,
            publishedAt: release.effectiveDate,
            modifiedAt: release.effectiveDate,
          }
        : {}),
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
