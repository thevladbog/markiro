import { Text } from "react-email";
import {
  EmailAction,
  EmailExpiryNotice,
  EmailFallbackLink,
  EmailLayout,
  emailStyles,
} from "./layout.js";
import { formatRussianMinutes } from "./duration.js";

export interface PasswordResetEmailProps {
  recipientName: string;
  actionUrl: string;
  expiresInMinutes: number;
}

export function PasswordResetEmail({
  recipientName,
  actionUrl,
  expiresInMinutes,
}: PasswordResetEmailProps) {
  return (
    <EmailLayout
      preview="Ссылка для восстановления доступа к Маркиро"
      eyebrow="Безопасность аккаунта"
      heading="Восстановление пароля"
    >
      <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
      <Text style={emailStyles.paragraph}>
        Мы получили запрос на смену пароля вашей учётной записи Маркиро.
      </Text>
      <Text style={emailStyles.paragraph}>
        Если вы не запрашивали смену пароля, ничего делать не нужно.
      </Text>
      <EmailAction href={actionUrl}>Сбросить пароль</EmailAction>
      <EmailExpiryNotice label="Одноразовая ссылка">
        Действует {formatRussianMinutes(expiresInMinutes)}.
      </EmailExpiryNotice>
      <EmailFallbackLink actionUrl={actionUrl} />
    </EmailLayout>
  );
}
