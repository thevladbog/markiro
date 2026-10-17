import { useTranslation } from "react-i18next";

import { Button } from "@markiro/ui";

import { PROTOCOL_VERSION } from "../../host/protocol.js";
import { useFloorUpdateEntry } from "../../update/floor-update-entry-context.js";
import "./sign-in-version-footer.css";

/**
 * The sign-in's last line: the program's version, and, when the host offers an update, a chip that
 * opens the «С хоста» dialog (nobody is signed in, so no shift is interrupted). Quiet text until
 * there is something to do; the operator's actions above it stay as they were.
 */
export function SignInVersionFooter() {
  const { t } = useTranslation();
  const entry = useFloorUpdateEntry();
  if (entry === null || entry.appVersion === null) return null;
  const offered = entry.offer.kind === "available" && entry.reachable && !entry.inShift;
  return (
    <footer className="sign-in-version" data-offer={offered ? "true" : undefined}>
      <span className="sign-in-version__text">
        {t("floor.update.entry.chipVersion", {
          version: entry.appVersion,
          protocol: PROTOCOL_VERSION,
        })}
      </span>
      {offered && (
        <Button size="floor" variant="secondary" onClick={entry.open}>
          {t("floor.update.entry.chip")}
        </Button>
      )}
    </footer>
  );
}
