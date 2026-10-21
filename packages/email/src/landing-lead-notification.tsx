import { Link, Section, Text } from "react-email";
import { EmailLayout, emailStyles, type EmailLocale } from "./layout.js";
import {
  formatLinesBucket,
  formatUtcInstant,
  formatUtm,
  SummaryRow,
  SummaryTable,
  type LandingLeadUtmProps,
} from "./landing-lead-parts.js";

export type LandingLeadIntent = "download" | "invoice";

/** The owner's copy of a landing form (spec §15.3); unlike Telegram it carries the contacts. */
export interface LandingLeadNotificationEmailProps {
  intent: LandingLeadIntent;
  locale: EmailLocale;
  requestId: string;
  receivedAt: Date;
  sourcePath: string;
  consentVersion: string;
  /** Absent when the price-page form asked for the INN only. */
  company?: string;
  email: string;
  name?: string;
  phone?: string;
  inn?: string;
  tariffCode?: string;
  productGroup?: string;
  linesBucket?: string;
  utm?: LandingLeadUtmProps;
  referrer?: string;
  /** False when the e-mail already had a lead: a repeat download or a later invoice request. */
  firstContact: boolean;
  leadUrl: string;
}

const INTENT = { download: "скачивание", invoice: "запрос счёта" } as const;

export function landingLeadNotificationSubject(
  intent: LandingLeadIntent,
  company: string | undefined,
  inn: string | undefined,
): string {
  const who = company ?? (inn === undefined ? "компания не указана" : `ИНН ${inn}`);
  return `${intent === "invoice" ? "Запрос счёта" : "Скачивание"} · ${who} — Маркиро`;
}

export function LandingLeadNotificationEmail(props: LandingLeadNotificationEmailProps) {
  const utm = formatUtm(props.utm);
  const lines = formatLinesBucket(props.linesBucket);
  return (
    <EmailLayout
      locale="ru"
      preview={`${props.firstContact ? "Новый лид" : "Повторное обращение"} · ${INTENT[props.intent]}`}
      eyebrow="markiro.app"
      heading={props.intent === "invoice" ? "Запрос счёта" : "Скачивание пробной версии"}
      footer="Это внутреннее операционное письмо о заявке с markiro.app."
    >
      <Text style={emailStyles.paragraph}>
        {props.firstContact
          ? "С сайта пришёл новый лид."
          : "Обращение от уже известного лида: данные дополнены в карточке."}
      </Text>
      <SummaryTable label="Данные заявки">
        <SummaryRow label="Вид">{INTENT[props.intent]}</SummaryRow>
        <SummaryRow label="Компания">{props.company ?? "не указана"}</SummaryRow>
        {props.inn !== undefined ? <SummaryRow label="ИНН">{props.inn}</SummaryRow> : null}
        {props.tariffCode !== undefined ? (
          <SummaryRow label="Тариф">{props.tariffCode}</SummaryRow>
        ) : null}
        <SummaryRow label="Email">{props.email}</SummaryRow>
        {props.name !== undefined ? <SummaryRow label="Имя">{props.name}</SummaryRow> : null}
        {props.phone !== undefined ? <SummaryRow label="Телефон">{props.phone}</SummaryRow> : null}
        {props.productGroup !== undefined ? (
          <SummaryRow label="Товарная группа">{props.productGroup}</SummaryRow>
        ) : null}
        {lines !== null ? <SummaryRow label="Линии">{lines}</SummaryRow> : null}
        <SummaryRow label="Страница">{props.sourcePath}</SummaryRow>
        {utm !== null ? <SummaryRow label="UTM">{utm}</SummaryRow> : null}
        {props.referrer !== undefined ? (
          <SummaryRow label="Откуда пришёл">{props.referrer}</SummaryRow>
        ) : null}
        <SummaryRow label="Язык посетителя">
          {props.locale === "ru" ? "Русский (ru)" : "English (en)"}
        </SummaryRow>
        <SummaryRow label="Получена">{formatUtcInstant(props.receivedAt)}</SummaryRow>
        <SummaryRow label="ID заявки">{props.requestId}</SummaryRow>
        <SummaryRow label="Версия согласия">{props.consentVersion}</SummaryRow>
      </SummaryTable>
      <Section style={emailStyles.fallback}>
        <Text style={emailStyles.muted}>Карточка лида в SaaS-админке:</Text>
        <Link href={props.leadUrl} style={emailStyles.fallbackLink}>
          {props.leadUrl}
        </Link>
      </Section>
    </EmailLayout>
  );
}
