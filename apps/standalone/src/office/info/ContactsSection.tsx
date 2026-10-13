import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, DefinitionGrid } from "@markiro/ui";

import { useAbout } from "./about-context.js";
import { ALTERNATIVE_SUPPORT_EMAIL, PRIMARY_SUPPORT_EMAIL, supportMailLink } from "./contacts.js";

/** «Контакты и поддержка»: the two support addresses; a click opens the mail program through the shell. */
export function ContactsSection() {
  const { t } = useTranslation();
  const about = useAbout();
  const [failed, setFailed] = useState(false);
  const open = (email: string) => {
    setFailed(false);
    about.openLink(supportMailLink(email)).catch(() => setFailed(true));
  };
  const mailButton = (email: string) => (
    <Button
      variant="secondary"
      size="compact"
      onClick={() => open(email)}
      aria-label={t("office.about.contacts.writeTo", { email })}
    >
      {email}
    </Button>
  );
  return (
    <Card title={t("office.about.contacts.title")} titleAs="h2">
      <div className="standalone-form">
        <DefinitionGrid
          items={[
            {
              id: "email",
              term: t("office.about.contacts.email"),
              description: mailButton(PRIMARY_SUPPORT_EMAIL),
            },
            {
              id: "alternative",
              term: t("office.about.contacts.alternative"),
              description: mailButton(ALTERNATIVE_SUPPORT_EMAIL),
            },
          ]}
        />
        <div aria-live="polite">
          {failed && (
            <Alert tone="warn" role="presentation">
              {t("office.about.contacts.openFailed", {
                email: PRIMARY_SUPPORT_EMAIL,
                other: ALTERNATIVE_SUPPORT_EMAIL,
              })}
            </Alert>
          )}
        </div>
      </div>
    </Card>
  );
}
