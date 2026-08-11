import { Text } from "react-email";
import {
  EmailAction,
  EmailExpiryNotice,
  EmailFallbackLink,
  EmailLayout,
  emailStyles,
} from "./layout.js";

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
    <EmailLayout
      preview={`Вас пригласили в ${organizationName}`}
      eyebrow={organizationName}
      heading="Приглашение в команду"
    >
      <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
      <Text style={emailStyles.paragraph}>
        {inviterName} приглашает вас присоединиться к {organizationName} в Маркиро.
      </Text>
      <EmailAction href={actionUrl}>Принять приглашение</EmailAction>
      <EmailExpiryNotice label="Приглашение действительно до">
        {dateFormatter.format(expiresAt)}
      </EmailExpiryNotice>
      <EmailFallbackLink actionUrl={actionUrl} />
    </EmailLayout>
  );
}
