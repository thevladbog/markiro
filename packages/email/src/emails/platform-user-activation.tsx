import { Button, Link, Section, Text } from "react-email";
import { formatRussianMinutes } from "../duration.js";
import { EmailLayout, emailStyles } from "../layout.js";

export interface PlatformUserActivationEmailProps {
  recipientName: string;
  actionUrl: string;
  expiresInMinutes: number;
}

export function PlatformUserActivationEmail({
  recipientName,
  actionUrl,
  expiresInMinutes,
}: PlatformUserActivationEmailProps) {
  return (
    <EmailLayout
      preview="Доступ к платформе управления Маркиро"
      heading="Добро пожаловать в Маркиро"
      footer="Это автоматическое письмо о создании доступа к платформе управления. Если адрес указан ошибочно, просто удалите письмо."
    >
      <Text style={emailStyles.paragraph}>Здравствуйте, {recipientName}!</Text>
      <Text style={emailStyles.paragraph}>
        Для вас создан доступ к платформе управления Маркиро. По одноразовой ссылке выберите пароль,
        затем настройте двухфакторную аутентификацию.
      </Text>
      <Section style={emailStyles.actionSection}>
        <Button href={actionUrl} style={emailStyles.button}>
          Активировать доступ
        </Button>
      </Section>
      <Text style={emailStyles.muted}>
        Одноразовая ссылка действует {formatRussianMinutes(expiresInMinutes)}.
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
