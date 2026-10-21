import { Link, Section, Text } from "react-email";
import { EmailLayout, emailStyles } from "./layout.js";
import { formatCivilDate } from "./landing-lead-parts.js";

/** Sections of the daily «кому пора написать» digest, in display order (spec §15.5). */
export const LANDING_LEAD_DIGEST_SECTIONS = [
  "new_uncontacted",
  "day_3",
  "day_10",
  "touch_due",
  "invoice_unpaid",
] as const;
export type LandingLeadDigestSection = (typeof LANDING_LEAD_DIGEST_SECTIONS)[number];

export const LANDING_LEAD_DIGEST_TITLES: Record<LandingLeadDigestSection, string> = {
  new_uncontacted: "Новые без контакта",
  day_3: "3-й день: получилось провести смену?",
  day_10: "10-й день: продление или счёт",
  touch_due: "Пора написать",
  invoice_unpaid: "Счёт без оплаты больше 7 дней",
};

/** Company and card link only: the digest carries no contacts (spec §15.5). */
export interface LandingLeadDigestEmailProps {
  digestDate: string;
  sections: { section: LandingLeadDigestSection; leads: { company: string; leadUrl: string }[] }[];
  leadsUrl: string;
}

export function landingLeadDigestSubject(digestDate: string): string {
  return `Кому пора написать · ${formatCivilDate(digestDate)} — Маркиро`;
}

export function LandingLeadDigestEmail({
  digestDate,
  sections,
  leadsUrl,
}: LandingLeadDigestEmailProps) {
  const total = sections.reduce((sum, section) => sum + section.leads.length, 0);
  return (
    <EmailLayout
      locale="ru"
      preview={`Сводка лидов на ${formatCivilDate(digestDate)}: ${total}`}
      eyebrow="Заявки"
      heading="Кому пора написать"
      footer="Это внутренняя ежедневная сводка заявок с markiro.app."
    >
      {sections.map(({ section, leads }) => (
        <Section key={section} aria-label={LANDING_LEAD_DIGEST_TITLES[section]}>
          <Text style={emailStyles.greeting}>
            {`${LANDING_LEAD_DIGEST_TITLES[section]} (${leads.length})`}
          </Text>
          {leads.map((lead) => (
            <Text key={lead.leadUrl} style={emailStyles.paragraph}>
              {lead.company + " · "}
              <Link href={lead.leadUrl} style={emailStyles.fallbackLink}>
                {lead.leadUrl}
              </Link>
            </Text>
          ))}
        </Section>
      ))}
      <Section style={emailStyles.fallback}>
        <Text style={emailStyles.muted}>Все заявки:</Text>
        <Link href={leadsUrl} style={emailStyles.fallbackLink}>
          {leadsUrl}
        </Link>
      </Section>
    </EmailLayout>
  );
}
