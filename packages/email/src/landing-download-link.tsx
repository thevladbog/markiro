import { Link, Section, Text } from "react-email";
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
    heading: "Маркиро Автоном для вашего компьютера",
    greeting: (company: string) => `Здравствуйте! Это письмо для компании ${company}.`,
    intro:
      "На странице загрузки всегда лежит последняя версия установщика для Windows, его размер и контрольная сумма SHA-256.",
    action: "Открыть страницу загрузки",
    fallback: "Ссылка на страницу:",
    trialTitle: "Пробный период",
    trial:
      "14 дней с завершения мастера установки, все функции без ограничений. Мастер может сразу создать демо-данные, чтобы провести пробную смену без оборудования.",
    smartScreenTitle: "Если Windows покажет предупреждение",
    smartScreen:
      "Установщик пока не подписан сертификатом издателя, поэтому SmartScreen может показать окно «Система Windows защитила ваш компьютер». Нажмите «Подробнее», затем «Выполнить в любом случае».",
    checksum:
      "Перед запуском можно сверить файл с контрольной суммой на странице. В PowerShell: Get-FileHash .\\<файл> -Algorithm SHA256.",
    callTitle: "Созвон на 30 минут",
    call: (email: string) =>
      `Поможем с установкой, шаблоном этикетки и первой сменой. Ответьте на это письмо или напишите на ${email}, подберём удобное время.`,
    footer: "Вы получили это письмо, потому что запросили пробную версию на markiro.app.",
  },
  en: {
    subject: "Your link to the Markiro Standalone trial",
    preview: "Download page, file check and a 14-day trial",
    eyebrow: "Trial",
    heading: "Markiro Standalone for your computer",
    greeting: (company: string) => `Hello! This message is for ${company}.`,
    intro:
      "The download page always carries the latest Windows installer with its size and SHA-256 checksum.",
    action: "Open the download page",
    fallback: "Page link:",
    trialTitle: "Trial",
    trial:
      "14 days from the end of the setup wizard, every feature included. The wizard can add demo data so you can run a trial shift without hardware.",
    smartScreenTitle: "If Windows shows a warning",
    smartScreen:
      "The installer is not yet signed with a publisher certificate, so SmartScreen may say “Windows protected your PC”. Choose “More info”, then “Run anyway”.",
    checksum:
      "Before running it you can compare the file with the checksum on the page. In PowerShell: Get-FileHash .\\<file> -Algorithm SHA256.",
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
  return (
    <EmailLayout
      locale={locale}
      preview={text.preview}
      eyebrow={text.eyebrow}
      heading={text.heading}
      footer={text.footer}
    >
      <Text style={emailStyles.greeting}>{text.greeting(company)}</Text>
      <Text style={emailStyles.paragraph}>{text.intro}</Text>
      <EmailAction href={downloadPageUrl}>{text.action}</EmailAction>
      <Section style={emailStyles.fallback}>
        <Text style={emailStyles.muted}>{text.fallback}</Text>
        <Link href={downloadPageUrl} style={emailStyles.fallbackLink}>
          {downloadPageUrl}
        </Link>
      </Section>
      <Text style={emailStyles.greeting}>{text.trialTitle}</Text>
      <Text style={emailStyles.paragraph}>{text.trial}</Text>
      <Text style={emailStyles.greeting}>{text.smartScreenTitle}</Text>
      <Text style={emailStyles.paragraph}>{text.smartScreen}</Text>
      <Text style={emailStyles.paragraph}>{text.checksum}</Text>
      <Text style={emailStyles.greeting}>{text.callTitle}</Text>
      <Text style={emailStyles.paragraph}>{text.call(contactEmail)}</Text>
    </EmailLayout>
  );
}
