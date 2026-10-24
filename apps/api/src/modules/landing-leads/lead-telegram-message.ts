import { LANDING_LEAD_DIGEST_SECTIONS, LANDING_LEAD_DIGEST_TITLES } from "@markiro/email";
import type { LeadDigestSections } from "./lead-digest-sections";
import { TELEGRAM_MESSAGE_LIMIT } from "./telegram.client";

/**
 * Telegram is a foreign service: sending e-mails, names or phones there is a cross-border
 * transfer of personal data (spec §15.4). These builders take only company, product
 * group, lines, tariff, source, UTM and the card link, and still scrub anything that
 * looks like an e-mail address or a phone number out of those free-text fields.
 */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+/g;
const PHONE_LIKE = /\+?\d[\d\s().-]{8,}\d/g;

export function scrubContacts(value: string): string {
  return value.replace(EMAIL_LIKE, "…").replace(PHONE_LIKE, "…").slice(0, 200);
}

/** Shown instead of a missing company; an INN (a person's, for a sole trader) never goes out. */
export const NO_COMPANY = "компания не указана";

const LINES: Record<string, string> = { "1": "1 линия", "2-3": "2–3 линии", "4+": "4+ линий" };

export interface LeadAlertFacts {
  kind: "download" | "invoice_request" | "demo_request";
  firstContact: boolean;
  /** `null` for an invoice request that gave the INN only; the INN is never sent. */
  company: string | null;
  productGroup: string | null;
  linesBucket: string | null;
  tariffCode: string | null;
  sourcePath: string | null;
  utm: Record<string, unknown> | null;
  leadUrl: string;
}

const KIND_TITLE = {
  download: "скачивание",
  invoice_request: "запрос счёта",
  demo_request: "заявка на демо",
} as const;

export function leadAlertText(facts: LeadAlertFacts): string {
  const title = `${facts.firstContact ? "Новый лид" : "Повторное обращение"} · ${KIND_TITLE[facts.kind]}`;
  const about = [
    facts.company === null ? NO_COMPANY : scrubContacts(facts.company),
    facts.productGroup === null ? null : scrubContacts(facts.productGroup),
    facts.linesBucket === null ? null : (LINES[facts.linesBucket] ?? null),
  ].filter((part): part is string => part !== null && part !== "");
  const utm = utmText(facts.utm);
  const source = [
    facts.sourcePath === null ? null : `Источник: ${scrubContacts(facts.sourcePath)}`,
    utm === null ? null : `utm: ${utm}`,
  ].filter((part): part is string => part !== null);
  return [
    title,
    about.join(" · "),
    facts.tariffCode === null ? null : `Тариф: ${scrubContacts(facts.tariffCode)}`,
    source.length === 0 ? null : source.join(" · "),
    facts.leadUrl,
  ]
    .filter((line): line is string => line !== null && line !== "")
    .join("\n");
}

function utmText(utm: Record<string, unknown> | null): string | null {
  if (utm === null) return null;
  const parts = ["source", "medium", "campaign"]
    .map((key) => utm[key])
    .filter((value): value is string => typeof value === "string" && value !== "")
    .map(scrubContacts);
  return parts.length === 0 ? null : parts.join(" / ");
}

const DIGEST_SECTION_LIMIT = 15;

export function leadDigestText(
  digestDate: string,
  sections: LeadDigestSections<{ company: string; leadUrl: string }>,
  leadsUrl: string,
): string {
  const [year, month, day] = digestDate.split("-");
  const lines = [`Кому пора написать · ${day}.${month}.${year}`];
  for (const section of LANDING_LEAD_DIGEST_SECTIONS) {
    const leads = sections[section];
    if (leads.length === 0) continue;
    lines.push("", `${LANDING_LEAD_DIGEST_TITLES[section]} (${leads.length})`);
    for (const lead of leads.slice(0, DIGEST_SECTION_LIMIT)) {
      lines.push(`• ${scrubContacts(lead.company)} — ${lead.leadUrl}`);
    }
    if (leads.length > DIGEST_SECTION_LIMIT) {
      lines.push(`…и ещё ${leads.length - DIGEST_SECTION_LIMIT}`);
    }
  }
  lines.push("", `Все заявки: ${leadsUrl}`);
  const text = lines.join("\n");
  return text.length <= TELEGRAM_MESSAGE_LIMIT
    ? text
    : `${text.slice(0, TELEGRAM_MESSAGE_LIMIT - 40)}\n…\nВсе заявки: ${leadsUrl}`;
}
