import { Button, Link, Section, Text } from "react-email";
import { EmailLayout, emailStyles } from "./layout.js";

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
      heading="Восстановление пароля"
    >
      <Text style={emailStyles.paragraph}>Здравствуйте, {recipientName}!</Text>
      <Text style={emailStyles.paragraph}>
        Мы получили запрос на смену пароля вашей учётной записи Маркиро.
      </Text>
      <Section style={emailStyles.actionSection}>
        <Button href={actionUrl} style={emailStyles.button}>
          Сбросить пароль
        </Button>
      </Section>
      <Text style={emailStyles.muted}>Ссылка действует {expiresInMinutes} минут.</Text>
      <Text style={emailStyles.fallback}>
        Если кнопка не работает, откройте ссылку:{" "}
        <Link href={actionUrl} style={emailStyles.fallbackLink}>
          {actionUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}
