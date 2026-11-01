import { Heading, Link, Section, Text } from "react-email";
import { EmailAction, EmailLayout, emailStyles, type EmailLocale } from "./layout.js";

export interface LandingDownloadLinkEmailProps {
  locale: EmailLocale;
  company: string;
  /** The landing download page, never the installer itself: the version changes. */
  downloadPageUrl: string;
  contactEmail: string;
}

const copy = {
  ru: {
    subject: "Ссылка на пробную версию Маркиро Автоном",
    preview: "Страница загрузки, проверка файла и пробный период на 14 дней",
    eyebrow: "Пробная версия",
    heading: "Скачайте Маркиро Автоном",
    greeting: (company: string) => `Вы запросили пробную версию для компании ${company}.`,
    intro:
      "Откройте ссылку на компьютере с Windows. На странице вы найдёте последнюю версию установщика, размер файла и контрольную сумму SHA-256.",
    action: "Открыть страницу загрузки",
    fallback: "Ссылка на страницу:",
    trialTitle: "Пробный период",
    trial:
      "Пробный период длится 14 дней с завершения мастера установки. Все функции доступны без ограничений. В мастере можно добавить демо-данные и провести пробную смену без оборудования.",
    smartScreenTitle: "Если Windows покажет предупреждение",
    smartScreen:
      "Установщик пока не подписан сертификатом издателя, поэтому SmartScreen может показать окно «Система Windows защитила ваш компьютер». Нажмите «Подробнее», затем «Выполнить в любом случае».",
    checksum:
      "Перед запуском сверьте SHA-256 скачанного файла с суммой на странице загрузки. Откройте PowerShell в папке с установщиком и подставьте имя файла в команду:",
    callTitle: "Созвон на 30 минут",
    call: (email: string) =>
      `Поможем установить программу, настроить шаблон этикетки и провести первую смену. Чтобы договориться о времени, ответьте на это письмо или напишите на ${email}.`,
    footer: "Вы получили это письмо, потому что запросили пробную версию на markiro.app.",
  },
  en: {
    subject: "Your link to the Markiro Standalone trial",
    preview: "Download page, file check and a 14-day trial",
    eyebrow: "Trial",
    heading: "Download Markiro Standalone",
    greeting: (company: string) => `You requested a trial for ${company}.`,
    intro:
      "Open the link on your Windows computer. The page has the latest installer, its file size and SHA-256 checksum.",
    action: "Open the download page",
    fallback: "Page link:",
    trialTitle: "Trial",
    trial:
      "14 days from the end of the setup wizard, every feature included. The wizard can add demo data so you can run a trial shift without hardware.",
    smartScreenTitle: "If Windows shows a warning",
    smartScreen:
      "The installer is not yet signed with a publisher certificate, so SmartScreen may say “Windows protected your PC”. Choose “More info”, then “Run anyway”.",
    checksum:
      "Before running the installer, compare its SHA-256 checksum with the one on the download page. Open PowerShell in the installer folder and replace the placeholder with the file name:",
    callTitle: "A 30-minute call",
    call: (email: string) =>
      `We will help with installation, the label template and the first shift. Reply to this message or write to ${email} to pick a time.`,
    footer: "You received this message because you requested the trial on markiro.app.",
  },
} as const;

export function landingDownloadLinkSubject(locale: EmailLocale): string {
  return copy[locale].subject;
}

export function LandingDownloadLinkEmail({
  locale,
  company,
  downloadPageUrl,
  contactEmail,
}: LandingDownloadLinkEmailProps) {
  const text = copy[locale];
  const command =
    locale === "ru"
      ? "Get-FileHash .\\<файл> -Algorithm SHA256"
      : "Get-FileHash .\\<file> -Algorithm SHA256";
  return (
    <EmailLayout
      locale={locale}
      preview={text.preview}
      eyebrow={text.eyebrow}
      heading={text.heading}
      footer={text.footer}
    >
      <Text style={emailStyles.greeting}>{locale === "ru" ? "Здравствуйте!" : "Hello!"}</Text>
      <Text style={emailStyles.paragraph}>{text.greeting(company)}</Text>
      <Text style={emailStyles.paragraph}>{text.intro}</Text>
      <EmailAction href={downloadPageUrl}>{text.action}</EmailAction>
      <Section style={downloadStyles.fallback}>
        <Text style={downloadStyles.fallbackLabel}>{text.fallback}</Text>
        <Link href={downloadPageUrl} style={emailStyles.fallbackLink}>
          {downloadPageUrl}
        </Link>
      </Section>
      <Section style={downloadStyles.section}>
        <Heading as="h2" style={downloadStyles.heading}>
          {text.trialTitle}
        </Heading>
        <Text style={downloadStyles.paragraph}>{text.trial}</Text>
      </Section>
      <Section style={downloadStyles.section}>
        <Heading as="h2" style={downloadStyles.heading}>
          {locale === "ru" ? "Проверка файла" : "Check the file"}
        </Heading>
        <Text style={downloadStyles.paragraph}>{text.checksum}</Text>
        <Text style={downloadStyles.command}>{command}</Text>
        <Heading as="h2" style={downloadStyles.warningHeading}>
          {text.smartScreenTitle}
        </Heading>
        <Text style={downloadStyles.paragraph}>{text.smartScreen}</Text>
      </Section>
      <Section style={downloadStyles.section}>
        <Heading as="h2" style={downloadStyles.heading}>
          {text.callTitle}
        </Heading>
        <Text style={downloadStyles.paragraph}>
          {text.call(contactEmail).split(contactEmail)[0]}
          <Link href={`mailto:${contactEmail}`} style={downloadStyles.link}>
            {contactEmail}
          </Link>
          {text.call(contactEmail).split(contactEmail)[1]}
        </Text>
      </Section>
    </EmailLayout>
  );
}

const downloadStyles = {
  section: { marginTop: "28px", borderTop: "1px solid #e0ded7", paddingTop: "24px" },
  heading: { ...emailStyles.greeting, fontSize: "18px", margin: "0 0 10px" },
  warningHeading: { ...emailStyles.greeting, margin: "20px 0 10px" },
  paragraph: { ...emailStyles.paragraph, margin: 0 },
  fallback: { ...emailStyles.fallback, margin: "16px 0 0" },
  fallbackLabel: { ...emailStyles.muted, margin: "0 0 4px" },
  command: {
    ...emailStyles.paragraph,
    fontFamily: '"Courier New", monospace',
    fontSize: "13px",
    lineHeight: "20px",
    backgroundColor: "#f0efea",
    padding: "12px",
    margin: "12px 0 0",
    overflowWrap: "anywhere" as const,
  },
  link: { color: "#1a4f9c", textDecoration: "underline" },
} as const;
