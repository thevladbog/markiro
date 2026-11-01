import { LANDING_LEAD_DIGEST_SECTIONS, LANDING_LEAD_DIGEST_TITLES } from "@markiro/email";
import type { LeadDigestSections } from "./lead-digest-sections";

export const NO_COMPANY = "компания не указана";

// Never echo free-text form values, including valid but unknown tariff codes.
const TARIFF_TITLES = new Map([
  ["start", "Старт"],
  ["line", "Линия"],
  ["workshop", "Цех"],
  ["plant", "Завод"],
]);
const PAGE_TITLES = new Map([
  ["/", "Главная"],
  ["/skachat/", "Скачать"],
  ["/stoimost/", "Стоимость"],
]);
const RECEIVED_AT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export interface LeadAlertFacts {
  kind: "download" | "invoice_request" | "demo_request";
  firstContact: boolean;
  tariffCode: string | null;
  sourcePath: string | null;
  receivedAt: Date;
  /** Server-built protected card URL, without contact data or access tokens. */
  leadUrl: string;
}
const KIND_TITLE = {
  download: "скачивание",
  invoice_request: "запрос счёта",
  demo_request: "заявка на демо",
} as const;

/** Fixed request context and a protected link; no contacts or free-text form values. */
export function leadAlertText(facts: LeadAlertFacts): string {
  const tariff = TARIFF_TITLES.get(facts.tariffCode ?? "");
  const page = PAGE_TITLES.get(facts.sourcePath ?? "");
  return [
    `${facts.firstContact ? "Новый лид" : "Повторное обращение"} · ${KIND_TITLE[facts.kind]}`,
    ...(tariff === undefined ? [] : [`Тариф: ${tariff}`]),
    ...(page === undefined ? [] : [`Страница: ${page}`]),
    `Получено: ${RECEIVED_AT.format(facts.receivedAt)} МСК`,
    `Открыть заявку: ${facts.leadUrl}`,
  ].join("\n");
}

/** No names, identifiers, company details or customer URLs in a digest. */
export function leadDigestText(
  digestDate: string,
  sections: LeadDigestSections<unknown>,
  leadsUrl: string,
): string {
  const [year, month, day] = digestDate.split("-");
  const lines = [`Кому пора написать · ${day}.${month}.${year}`];
  for (const section of LANDING_LEAD_DIGEST_SECTIONS) {
    if (sections[section].length)
      lines.push("", `${LANDING_LEAD_DIGEST_TITLES[section]} (${sections[section].length})`);
  }
  return [...lines, "", `Все заявки: ${leadsUrl}`].join("\n");
}
