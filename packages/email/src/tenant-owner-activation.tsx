import { Button, Link, Section, Text } from "react-email";
import { formatRussianMinutes } from "./duration.js";
import { EmailLayout, emailStyles } from "./layout.js";

export interface TenantOwnerActivationEmailProps {
  recipientName: string;
  organizationName: string;
  actionUrl: string;
  expiresInMinutes: number;
}

export function TenantOwnerActivationEmail({
  recipientName,
  organizationName,
  actionUrl,
  expiresInMinutes,
}: TenantOwnerActivationEmailProps) {
  return (
    <EmailLayout
      preview={`Доступ к ${organizationName} в Маркиро`}
      heading="Добро пожаловать в Маркиро"
      footer="Это автоматическое письмо о создании кабинета организации. Если адрес указан ошибочно, просто удалите письмо."
    >
      <Text style={emailStyles.paragraph}>Здравствуйте, {recipientName}!</Text>
      <Text style={emailStyles.paragraph}>
        Для вас создан кабинет организации {organizationName}. Активируйте доступ по ссылке. Если у
        вас уже есть аккаунт Маркиро, его пароль останется без изменений.
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
