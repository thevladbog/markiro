import { Button, Link, Section, Text } from "react-email";
import { EmailLayout, emailStyles } from "./layout.js";
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
      heading="Подтвердите email"
    >
      <Text style={emailStyles.paragraph}>Здравствуйте, {recipientName}!</Text>
      <Text style={emailStyles.paragraph}>
        Подтвердите адрес электронной почты, чтобы завершить настройку учётной записи.
      </Text>
      <Section style={emailStyles.actionSection}>
        <Button href={actionUrl} style={emailStyles.button}>
          Подтвердить email
        </Button>
      </Section>
      <Text style={emailStyles.muted}>
        Ссылка действует {formatRussianMinutes(expiresInMinutes)}.
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
