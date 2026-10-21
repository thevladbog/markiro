import { Text } from "react-email";
import { EmailLayout, emailStyles, type EmailLocale } from "./layout.js";
import { SummaryRow, SummaryTable } from "./landing-lead-parts.js";

export interface LandingInvoiceRequestConfirmationEmailProps {
  locale: EmailLocale;
  /** Absent when the price-page form asked for the INN only. */
  company?: string;
  inn: string;
  tariffCode: string;
  email: string;
  contactEmail: string;
}

const copy = {
  ru: {
    subject: "Мы получили запрос счёта — Маркиро",
    preview: "Счёт и ссылку на договор-оферту пришлём на эту почту",
    eyebrow: "Запрос счёта",
    heading: "Запрос счёта получен",
    received: "Мы получили запрос счёта на лицензию Маркиро Автоном.",
    next: "Счёт и ссылку на договор-оферту пришлём на эту почту в рабочее время. Оплата счёта означает акцепт оферты.",
    bridge:
      "Чтобы работа не остановилась на время оплаты, вместе со счётом выдадим демо-файл лицензии на 14 дней с правами выбранного тарифа.",
    question: (email: string) =>
      `Если в запросе что-то не так, ответьте на это письмо или напишите на ${email}.`,
    summary: "Ваш запрос",
    company: "Компания",
    inn: "ИНН",
    tariff: "Тариф",
    email: "Почта для счёта",
    footer: "Это автоматическое подтверждение запроса счёта на markiro.app.",
  },
  en: {
    subject: "We received your invoice request — Markiro",
    preview: "We will send the invoice and the offer agreement to this address",
    eyebrow: "Invoice request",
    heading: "Invoice request received",
    received: "We received your invoice request for a Markiro Standalone license.",
    next: "We will send the invoice and a link to the offer agreement to this address during business hours. Paying the invoice accepts the offer.",
    bridge:
      "So that work does not stop while the payment is on its way, the invoice comes with a 14-day demo license file carrying the rights of the chosen plan.",
    question: (email: string) =>
      `If anything in the request is wrong, reply to this message or write to ${email}.`,
    summary: "Your request",
    company: "Company",
    inn: "INN",
    tariff: "Plan",
    email: "Invoice e-mail",
    footer: "This is an automated confirmation of your invoice request on markiro.app.",
  },
} as const;

export function landingInvoiceRequestConfirmationSubject(locale: EmailLocale): string {
  return copy[locale].subject;
}

export function LandingInvoiceRequestConfirmationEmail({
  locale,
  company,
  inn,
  tariffCode,
  email,
  contactEmail,
}: LandingInvoiceRequestConfirmationEmailProps) {
  const text = copy[locale];
  return (
    <EmailLayout
      locale={locale}
      preview={text.preview}
      eyebrow={text.eyebrow}
      heading={text.heading}
      footer={text.footer}
    >
      <Text style={emailStyles.paragraph}>{text.received}</Text>
      <Text style={emailStyles.paragraph}>{text.next}</Text>
      <Text style={emailStyles.paragraph}>{text.bridge}</Text>
      <SummaryTable label={text.summary}>
        {company !== undefined ? <SummaryRow label={text.company}>{company}</SummaryRow> : null}
        <SummaryRow label={text.inn}>{inn}</SummaryRow>
        <SummaryRow label={text.tariff}>{tariffCode}</SummaryRow>
        <SummaryRow label={text.email}>{email}</SummaryRow>
      </SummaryTable>
      <Text style={emailStyles.paragraph}>{text.question(contactEmail)}</Text>
    </EmailLayout>
  );
}
