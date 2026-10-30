import { LANDING_LEAD_DIGEST_SECTIONS, LANDING_LEAD_DIGEST_TITLES } from "@markiro/email";
import type { LeadDigestSections } from "./lead-digest-sections";

export const NO_COMPANY = "компания не указана";
const OPEN_LEADS = "Откройте раздел «Заявки» в панели управления.";

export interface LeadAlertFacts {
  kind: "download" | "invoice_request" | "demo_request";
  firstContact: boolean;
}
const KIND_TITLE = {
  download: "скачивание",
  invoice_request: "запрос счёта",
  demo_request: "заявка на демо",
} as const;

/** Only fixed service text goes to the external messenger: no free text or record links. */
export function leadAlertText(facts: LeadAlertFacts): string {
  return `${facts.firstContact ? "Новый лид" : "Повторное обращение"} · ${KIND_TITLE[facts.kind]}\n${OPEN_LEADS}`;
}

/** No names, identifiers, company details or customer URLs in a digest. */
export function leadDigestText(digestDate: string, sections: LeadDigestSections<unknown>): string {
  const [year, month, day] = digestDate.split("-");
  const lines = [`Кому пора написать · ${day}.${month}.${year}`];
  for (const section of LANDING_LEAD_DIGEST_SECTIONS) {
    if (sections[section].length)
      lines.push("", `${LANDING_LEAD_DIGEST_TITLES[section]} (${sections[section].length})`);
  }
  return [...lines, "", OPEN_LEADS].join("\n");
}
