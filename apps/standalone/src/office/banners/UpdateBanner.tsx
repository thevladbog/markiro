import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";

import { Alert, IconButton } from "@markiro/ui";

import { useUpdateOffer } from "../../update/offer-context.js";
import { useOfficeSession } from "../office-session.js";

/**
 * «Доступно обновление» above the office's pages (spec §10.11.5, points
 * T3/T6): the administrator gets a link to «Информация» → «Обновление», a
 * technologist the word that an administrator installs it. Closed for the
 * session: `OfficeShell` lives as long as the session does. A polite region
 * on the screen from the start, like `LicenseBanner`'s, so a strip that
 * appears is heard once (the alert loses its own role).
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const offer = useUpdateOffer();
  const { user } = useOfficeSession();
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const version = offer.kind === "available" ? offer.manifest.version : null;
  return (
    <div className="office-banner" aria-live="polite">
      {version !== null && closedFor !== version && (
        <Alert
          tone="info"
          role="presentation"
          action={
            <IconButton
              variant="secondary"
              icon={<span aria-hidden="true">×</span>}
              aria-label={t("office.banner.update.close")}
              onClick={(event) => {
                // The button goes with the strip: the focus moves to the page, never to the body.
                event.currentTarget.ownerDocument.querySelector<HTMLElement>("main")?.focus();
                setClosedFor(version);
              }}
            />
          }
        >
          {user.role === "admin" ? (
            <>
              {t("office.banner.update.admin", { version })}{" "}
              <Link to="/about#update">{t("office.banner.update.install")}</Link>
            </>
          ) : (
            t("office.banner.update.technologist")
          )}
        </Alert>
      )}
    </div>
  );
}
