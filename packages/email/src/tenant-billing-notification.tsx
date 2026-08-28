import { Text } from "react-email";
import { EmailAction, EmailLayout, emailStyles, type EmailLocale } from "./layout.js";

export const TENANT_BILLING_EVENT_KINDS = [
  "clarification_required",
  "offer_published",
  "invoice_due_soon",
  "act_ready",
] as const;

export type TenantBillingEventKind = (typeof TENANT_BILLING_EVENT_KINDS)[number];

export interface TenantBillingNotificationEmailProps {
  locale: EmailLocale;
  recipientName: string;
  organizationName: string;
  eventKind: TenantBillingEventKind;
  subjectName: string;
  actionUrl: string;
}

const copy = {
  ru: {
    greeting: (name: string) => `Здравствуйте, ${name}.`,
    clarification_required: {
      heading: "Требуется уточнение",
      subject: "Требуется уточнение",
      body: (subject: string, organization: string) =>
        `Маркиро запросил уточнение по заявке ${subject} организации ${organization}.`,
      action: "Открыть заявку",
    },
    offer_published: {
      heading: "Новое коммерческое предложение",
      subject: "Новое предложение",
      body: (subject: string, organization: string) =>
        `Для организации ${organization} опубликовано предложение ${subject}.`,
      action: "Открыть предложение",
    },
    invoice_due_soon: {
      heading: "Счёт ожидает оплаты",
      subject: "Счёт к оплате",
      body: (subject: string, organization: string) =>
        `Счёт ${subject} организации ${organization} ожидает оплаты.`,
      action: "Открыть счёт",
    },
    act_ready: {
      heading: "Акт доступен",
      subject: "Доступен акт",
      body: (subject: string, organization: string) =>
        `Акт ${subject} организации ${organization} доступен в кабинете.`,
      action: "Открыть документы",
    },
  },
  en: {
    greeting: (name: string) => `Hello, ${name}.`,
    clarification_required: {
      heading: "Clarification required",
      subject: "Clarification required",
      body: (subject: string, organization: string) =>
        `Markiro requested clarification for ${subject} at ${organization}.`,
      action: "Open request",
    },
    offer_published: {
      heading: "New commercial offer",
      subject: "New offer",
      body: (subject: string, organization: string) =>
        `A new offer ${subject} was published for ${organization}.`,
      action: "Open offer",
    },
    invoice_due_soon: {
      heading: "Invoice awaiting payment",
      subject: "Invoice due",
      body: (subject: string, organization: string) =>
        `Invoice ${subject} for ${organization} is awaiting payment.`,
      action: "Open invoice",
    },
    act_ready: {
      heading: "Act available",
      subject: "Act available",
      body: (subject: string, organization: string) =>
        `Act ${subject} for ${organization} is available in the cabinet.`,
      action: "Open documents",
    },
  },
} as const;

export function boundedBillingSubjectName(value: string): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 120);
}

export function tenantBillingNotificationSubject(
  locale: EmailLocale,
  eventKind: TenantBillingEventKind,
  subjectName: string,
): string {
  const safeName = boundedBillingSubjectName(subjectName);
  const brand = locale === "ru" ? "Маркиро" : "Markiro";
  return `${copy[locale][eventKind].subject}: ${safeName} — ${brand}`;
}

export function TenantBillingNotificationEmail({
  locale,
  recipientName,
  organizationName,
  eventKind,
  subjectName,
  actionUrl,
}: TenantBillingNotificationEmailProps) {
  const event = copy[locale][eventKind];
  const safeName = boundedBillingSubjectName(subjectName);
  return (
    <EmailLayout locale={locale} preview={`${event.subject}: ${safeName}`} heading={event.heading}>
      <Text style={emailStyles.greeting}>{copy[locale].greeting(recipientName)}</Text>
      <Text style={emailStyles.paragraph}>{event.body(safeName, organizationName)}</Text>
      <EmailAction href={actionUrl}>{event.action}</EmailAction>
    </EmailLayout>
  );
}
