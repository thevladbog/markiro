import type { ReactNode } from "react";
import { Section, Text } from "react-email";
import { EmailLayout, emailStyles, type EmailLocale } from "./layout.js";

export type LandingLocale = EmailLocale;

export interface LandingDemoNotificationEmailProps {
  locale: LandingLocale;
  requestId: string;
  receivedAt: Date;
  sourcePath: string;
  consentVersion: string;
  recipientName: string;
  company: string;
  email: string;
  phone?: string;
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

function formatReceivedAt(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    [pad(value.getUTCDate()), pad(value.getUTCMonth() + 1), value.getUTCFullYear()].join(".") +
    `, ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())} UTC`
  );
}

export function LandingDemoNotificationEmail({
  locale,
  requestId,
  receivedAt,
  sourcePath,
  consentVersion,
  recipientName,
  company,
  email,
  phone,
}: LandingDemoNotificationEmailProps) {
  return (
    <EmailLayout
      locale="ru"
      preview="Новая заявка на демонстрацию с markiro.app"
      eyebrow="markiro.app"
      heading="Новая заявка"
      footer="Это внутреннее операционное письмо о заявке с markiro.app."
    >
      <Text style={emailStyles.paragraph}>
        На сайте отправлена новая заявка на демонстрацию Маркиро.
      </Text>
      <Section aria-label="Данные заявки" style={emailStyles.summary}>
        <table cellPadding="0" cellSpacing="0" style={emailStyles.summaryTable}>
          <tbody>
            <SummaryRow label="ID заявки">{requestId}</SummaryRow>
            <SummaryRow label="Получена">{formatReceivedAt(receivedAt)}</SummaryRow>
            <SummaryRow label="Страница">{sourcePath}</SummaryRow>
            <SummaryRow label="Версия согласия">{consentVersion}</SummaryRow>
            <SummaryRow label="Язык посетителя">
              {locale === "ru" ? "Русский (ru)" : "English (en)"}
            </SummaryRow>
            <SummaryRow label="Имя">{recipientName}</SummaryRow>
            <SummaryRow label="Компания">{company}</SummaryRow>
            <SummaryRow label="Email">{email}</SummaryRow>
            {phone !== undefined ? <SummaryRow label="Телефон">{phone}</SummaryRow> : null}
          </tbody>
        </table>
      </Section>
    </EmailLayout>
  );
}
