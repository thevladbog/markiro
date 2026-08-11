import { Text } from "react-email";
import {
  EmailAction,
  EmailExpiryNotice,
  EmailFallbackLink,
  EmailLayout,
  emailStyles,
} from "./layout.js";
import { formatRussianMinutes } from "./duration.js";

export interface EmailVerificationEmailProps {
  recipientName: string;
  actionUrl: string;
  expiresInMinutes: number;
}

export function EmailVerificationEmail({
  recipientName,
  actionUrl,
  expiresInMinutes,
}: EmailVerificationEmailProps) {
  return (
    <EmailLayout
      preview="Подтвердите адрес электронной почты в Маркиро"
      eyebrow="Учётная запись"
      heading="Подтвердите email"
    >
      <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
      <Text style={emailStyles.paragraph}>
        Подтвердите адрес электронной почты, чтобы завершить настройку учётной записи.
      </Text>
      <EmailAction href={actionUrl}>Подтвердить email</EmailAction>
      <EmailExpiryNotice label="Одноразовая ссылка">
        Действует {formatRussianMinutes(expiresInMinutes)}.
      </EmailExpiryNotice>
      <EmailFallbackLink actionUrl={actionUrl} />
    </EmailLayout>
  );
}
