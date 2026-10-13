import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert, Button, Card, DefinitionGrid } from "@markiro/ui";

import { useAbout } from "./about-context.js";
import { SUPPORT_CONTACTS, supportMailLink } from "./contacts.js";

/** «Контакты и поддержка»: the vendor, the support address and the site; links go to the system's programs. */
export function ContactsSection() {
  const { t } = useTranslation();
  const about = useAbout();
  const [failed, setFailed] = useState(false);
  const open = (link: string) => {
    setFailed(false);
    about.openLink(link).catch(() => setFailed(true));
  };
  return (
    <Card title={t("office.about.contacts.title")} titleAs="h2">
      <div className="standalone-form">
        <DefinitionGrid
          items={[
            {
              id: "company",
              term: t("office.about.contacts.company"),
              description: SUPPORT_CONTACTS.companyName,
            },
            {
              id: "requisites",
              term: t("office.about.contacts.requisites"),
              description: SUPPORT_CONTACTS.requisites,
            },
            {
              id: "email",
              term: t("office.about.contacts.email"),
              description: (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => open(supportMailLink())}
                  aria-label={t("office.about.contacts.writeTo", { email: SUPPORT_CONTACTS.email })}
                >
                  {SUPPORT_CONTACTS.email}
                </Button>
              ),
            },
            {
              id: "site",
              term: t("office.about.contacts.site"),
              description: (
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={() => open(SUPPORT_CONTACTS.site.url)}
                  aria-label={t("office.about.contacts.openSite", {
                    site: SUPPORT_CONTACTS.site.label,
                  })}
                >
                  {SUPPORT_CONTACTS.site.label}
                </Button>
              ),
            },
          ]}
        />
        <div aria-live="polite">
          {failed && (
            <Alert tone="warn" role="presentation">
              {t("office.about.contacts.openFailed", { email: SUPPORT_CONTACTS.email })}
            </Alert>
          )}
        </div>
      </div>
    </Card>
  );
}
