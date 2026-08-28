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
    <Card title={t("status.title")}>
      <p>
        {status.tenantName}{" "}
        <StatusChip status={PHASE_TONE[status.phase]} label={t(`status.phase.${status.phase}`)} />
      </p>
      {status.lastTokenExpiresAt ? (
        <p>
          {t("status.tokenExpires", { at: new Date(status.lastTokenExpiresAt).toLocaleString() })}
        </p>
      ) : (
        <p>{t("status.noToken")}</p>
      )}
      {status.lastError ? <p>{status.lastError}</p> : null}
      <CertificatePicker selected={status.certThumbprint} onSelected={onChanged} />
      <JournalList entries={status.journal} />
      <Button variant="destructive" onClick={() => void bridge.unpair().then(onChanged)}>
        {t("status.unpair")}
      </Button>
    </Card>
  );
}
