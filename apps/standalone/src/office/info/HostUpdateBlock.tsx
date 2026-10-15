import { useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Button, Card } from "@markiro/ui";

import type { HostUpdateOffer } from "../../update/host-offer.js";
import { useUpdateOffer } from "../../update/offer-context.js";
import { UpdateFromHostDialog } from "../../update/UpdateFromHostDialog.js";
import { useOfficeSession } from "../office-session.js";
import { useAboutData } from "./about-data.js";
import { useUpdateShell } from "./update-context.js";
import { runUpdate } from "./update-flow.js";
import type { VerifiedReport } from "./update-shell.js";

function offerText(offer: HostUpdateOffer, appVersion: string, t: TFunction): string {
  switch (offer.kind) {
    case "none":
      return t("office.about.update.host.none");
    case "host_older":
      return t("office.about.update.host.hostOlder", {
        host: offer.hostVersion,
        app: offer.appVersion,
      });
    case "unavailable":
      return offer.reason === "verifying"
        ? t("office.about.update.host.verifying", { host: offer.hostVersion })
        : t("office.about.update.host.unavailable", { host: offer.hostVersion });
    case "needs_intermediate":
      return t("office.about.update.host.intermediate", { min: offer.minUpgradeFrom });
    case "available":
      return t("office.about.update.host.available", { host: offer.hostVersion, app: appVersion });
  }
}

/**
 * «С хоста» (spec §9.3, §10.11.5): on every PC but the host's — the host
 * updates from a file — what the host offers this PC. Only an administrator
 * downloads and installs; a technologist reads it.
 */
export function HostUpdateBlock() {
  const { t } = useTranslation();
  const offer = useUpdateOffer();
  const about = useAboutData();
  const session = useOfficeSession();
  const shell = useUpdateShell();
  const [open, setOpen] = useState(false);
  if (about.isPending || about.data?.role === "host") return null;
  const { user } = session;
  const appVersion = about.data?.appVersion ?? "—";
  // Plan ОБН-2's launch from the office: the `app.update.start` row with the
  // source `host`, then the shell checks the package again and starts it.
  const start = (report: VerifiedReport) =>
    runUpdate(
      {
        call: session.call,
        api: session.api,
        shell,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onPhase: () => undefined,
      },
      report,
      about.data?.role ?? "unknown",
      "host",
    );
  return (
    <Card title={t("office.about.update.host.title")} titleAs="h3">
      <p>{offerText(offer, appVersion, t)}</p>
      {offer.kind === "available" && user.role === "admin" && (
        <>
          <Button onClick={() => setOpen(true)}>{t("office.about.update.host.open")}</Button>
          <UpdateFromHostDialog
            open={open}
            offer={offer}
            onClose={() => setOpen(false)}
            start={start}
          />
        </>
      )}
      {offer.kind === "available" && user.role !== "admin" && (
        <p className="office-note">{t("office.about.update.host.adminOnly")}</p>
      )}
    </Card>
  );
}
