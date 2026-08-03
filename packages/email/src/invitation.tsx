import { Button, Link, Section, Text } from "react-email";
import { EmailLayout, emailStyles } from "./layout.js";

export interface OrganizationInvitationEmailProps {
  recipientName: string;
  organizationName: string;
  inviterName: string;
  actionUrl: string;
  expiresAt: Date;
}

const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
  timeZone: "UTC",
});

export function OrganizationInvitationEmail({
  recipientName,
  organizationName,
  inviterName,
  actionUrl,
  expiresAt,
}: OrganizationInvitationEmailProps) {
  return (
    <EmailLayout preview={"Вас пригласили в " + organizationName} heading="Приглашение в команду">
      <Text style={emailStyles.paragraph}>Здравствуйте, {recipientName}!</Text>
      <Text style={emailStyles.paragraph}>
        {inviterName} приглашает вас присоединиться к {organizationName} в Маркиро.
      </Text>
      <Section style={emailStyles.actionSection}>
        <Button href={actionUrl} style={emailStyles.button}>
          Принять приглашение
        </Button>
      </Section>
      <Text style={emailStyles.muted}>
        Приглашение действительно до {dateFormatter.format(expiresAt)}.
      </Text>
      <Text style={emailStyles.fallback}>
        Если кнопка не работает, откройте ссылку:{" "}
        <Link href={actionUrl} style={emailStyles.fallbackLink}>
          {actionUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}
