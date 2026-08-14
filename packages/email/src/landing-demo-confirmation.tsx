import type { ReactNode } from "react";
import { Section, Text } from "react-email";
import type { LandingLocale } from "./landing-demo-notification.js";
import { EmailLayout, emailStyles } from "./layout.js";

export interface LandingDemoConfirmationEmailProps {
  locale: LandingLocale;
  requestId: string;
  recipientName: string;
  company: string;
  email: string;
  phone?: string;
  contactEmail: string;
}

interface SummaryRowProps {
  label: string;
  children: ReactNode;
}

function SummaryRow({ label, children }: SummaryRowProps) {
  return (
    <tr>
      <th scope="row" style={emailStyles.summaryLabel}>
        {label + ": "}
      </th>
      <td style={emailStyles.summaryValue}>
        {children}
        <span style={{ display: "none" }}>
          <br />
        </span>
      </td>
    </tr>
  );
}

const copy = {
  ru: {
    preview: "Мы получили вашу заявку на демонстрацию Маркиро",
    eyebrow: "Заявка на демонстрацию",
    heading: "Заявка получена",
    greeting: (name: string) => `Здравствуйте, ${name}.`,
    received: "Мы получили вашу заявку на демонстрацию Маркиро.",
    followUp: "Мы свяжемся с вами, чтобы обсудить задачи вашей команды и показать продукт.",
    summaryLabel: "Ваша заявка",
    company: "Компания",
    email: "Email",
    phone: "Телефон",
    footer: "Это автоматическое подтверждение заявки на демонстрацию Маркиро.",
  },
  en: {
    preview: "We received your request for a Markiro demo",
    eyebrow: "Demo request",
    heading: "Request received",
    greeting: (name: string) => `Hello, ${name}.`,
    received: "We received your request for a Markiro demo.",
    followUp: "We will contact you to discuss your team's needs and show you the product.",
    summaryLabel: "Your request",
    company: "Company",
    email: "Email",
    phone: "Phone",
    footer: "This is an automated confirmation of your Markiro demo request.",
  },
} as const;

export function LandingDemoConfirmationEmail({
  locale,
  recipientName,
  company,
  email,
  phone,
}: LandingDemoConfirmationEmailProps) {
  const localized = copy[locale];
  return (
    <EmailLayout
      locale={locale}
      preview={localized.preview}
      eyebrow={localized.eyebrow}
      heading={localized.heading}
      footer={localized.footer}
    >
      <Text style={emailStyles.greeting}>{localized.greeting(recipientName)}</Text>
      <Text style={emailStyles.paragraph}>{localized.received}</Text>
      <Text style={emailStyles.paragraph}>{localized.followUp}</Text>
      <Section aria-label={localized.summaryLabel} style={emailStyles.summary}>
        <table cellPadding="0" cellSpacing="0" style={emailStyles.summaryTable}>
          <tbody>
            <SummaryRow label={localized.company}>{company}</SummaryRow>
            <SummaryRow label={localized.email}>{email}</SummaryRow>
            {phone !== undefined ? <SummaryRow label={localized.phone}>{phone}</SummaryRow> : null}
          </tbody>
        </table>
      </Section>
    </EmailLayout>
  );
}
