import { Text } from "react-email";
import { formatRussianMinutes } from "./duration.js";
import {
  EmailAction,
  EmailExpiryNotice,
  EmailFallbackLink,
  EmailLayout,
  emailStyles,
} from "./layout.js";

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
      eyebrow={organizationName}
      heading="Добро пожаловать в Маркиро"
      footer="Это автоматическое письмо о создании кабинета организации. Если адрес указан ошибочно, просто удалите письмо."
    >
      <Text style={emailStyles.greeting}>Здравствуйте, {recipientName}.</Text>
      <Text style={emailStyles.paragraph}>
        Для вас создан кабинет организации {organizationName}. Активируйте доступ по ссылке. Если у
        вас уже есть аккаунт Маркиро, его пароль останется без изменений.
      </Text>
      <EmailAction href={actionUrl}>Активировать доступ</EmailAction>
      <EmailExpiryNotice label="Одноразовая ссылка">
        Действует {formatRussianMinutes(expiresInMinutes)}.
      </EmailExpiryNotice>
      <EmailFallbackLink actionUrl={actionUrl} />
    </EmailLayout>
  );
}
