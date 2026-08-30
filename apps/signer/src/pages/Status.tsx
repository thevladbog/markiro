import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, StatusChip } from "@markiro/ui";
import { bridge, type AgentStatus } from "../lib/bridge.js";
import { CertificatePicker } from "../components/CertificatePicker.js";
import { JournalList } from "../components/JournalList.js";

const PHASE_TONE = {
  unpaired: "neutral",
  idle: "ok",
  working: "info",
  degraded: "error",
} as const;

export function Status({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Card title={t("status.title")} className="signer-status">
      <div className="signer-status__content">
        <section className="signer-status__summary" aria-label={t("status.summaryLabel")}>
          <div className="signer-status__tenant">
            <strong>{status.tenantName}</strong>
            <StatusChip
              status={PHASE_TONE[status.phase]}
              label={t(`status.phase.${status.phase}`)}
            />
          </div>
          <p className="signer-status__token">
            {status.lastTokenExpiresAt
              ? t("status.tokenExpires", {
                  at: new Date(status.lastTokenExpiresAt).toLocaleString(),
                })
              : t("status.noToken")}
          </p>
          {status.lastError ? <p className="signer-status__error">{status.lastError}</p> : null}
        </section>

        <section className="signer-status__section">
          <CertificatePicker selected={status.certThumbprint} onSelected={onChanged} />
        </section>

        <section className="signer-status__section" aria-labelledby="signer-journal-title">
          <h2 id="signer-journal-title" className="signer-status__section-title">
            {t("journal.title")}
          </h2>
          <JournalList entries={status.journal} />
        </section>

        <div className="signer-status__actions">
          <Button variant="destructive" onClick={() => void bridge.unpair().then(onChanged)}>
            {t("status.unpair")}
          </Button>
        </div>
      </div>
    </Card>
  );
}
