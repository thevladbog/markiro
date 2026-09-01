import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Card, DataTabs, StatusChip } from "@markiro/ui";
import { bridge, type AgentStatus } from "../lib/bridge.js";
import { CertificatePicker } from "../components/CertificatePicker.js";
import { JournalList } from "../components/JournalList.js";

const PHASE_TONE = {
  unpaired: "neutral",
  idle: "ok",
  working: "info",
  degraded: "error",
} as const;

type StatusTab = "status" | "journal";

export function Status({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<StatusTab>("status");
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [exportError, setExportError] = useState(false);
  const tabs = useMemo(
    () => [
      { id: "status" as const, label: t("tabs.status"), panelId: "signer-status-panel" },
      {
        id: "journal" as const,
        label: t("tabs.journal"),
        panelId: "signer-journal-panel",
        count: status.journal.length,
      },
    ],
    [status.journal.length, t],
  );

  const exportJournal = async (): Promise<void> => {
    setExporting(true);
    setExportError(false);
    setExportPath(null);
    try {
      const path = await bridge.exportJournal();
      if (path) setExportPath(path);
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card title={t("status.title")} className="signer-status" padding={0}>
      <div className="signer-status__tabs">
        <DataTabs
          items={tabs}
          activeId={activeTab}
          onChange={setActiveTab}
          label={t("tabs.label")}
        />
      </div>

      {activeTab === "status" ? (
        <div
          id="signer-status-panel"
          className="signer-status__content"
          role="tabpanel"
          aria-label={t("tabs.status")}
        >
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

          <div className="signer-status__actions">
            <Button variant="destructive" onClick={() => void bridge.unpair().then(onChanged)}>
              {t("status.unpair")}
            </Button>
          </div>
        </div>
      ) : (
        <div
          id="signer-journal-panel"
          className="signer-journal-panel"
          role="tabpanel"
          aria-label={t("tabs.journal")}
        >
          <div className="signer-journal-panel__header">
            <div>
              <h2>{t("journal.title")}</h2>
              <p>{t("journal.hint")}</p>
            </div>
            <Button
              size="compact"
              variant="secondary"
              loading={exporting}
              onClick={() => void exportJournal()}
            >
              {exporting ? t("journal.exporting") : t("journal.export")}
            </Button>
          </div>
          {exportPath ? (
            <Alert tone="ok">{t("journal.exported", { path: exportPath })}</Alert>
          ) : null}
          {exportError ? <Alert tone="error">{t("journal.exportFailed")}</Alert> : null}
          <JournalList entries={status.journal} />
        </div>
      )}
    </Card>
  );
}
