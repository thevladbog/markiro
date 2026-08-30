import { useTranslation } from "react-i18next";
import { Alert, Badge } from "@markiro/ui";

import type { RecordInventoryScanResult } from "../../lib/inventory-journal.js";

export interface InventoryScanInstrumentLabels {
  prompt: string;
  hint: string;
  expected: string;
  protected: string;
  ineligible: string;
  unknown: string;
  duplicateHere: string;
  duplicateOther: string;
  terminalHere: string;
  terminalOther: string;
  invalid: string;
  writeFailed: string;
  boxAccepted: (count: number) => string;
  boxBadge: string;
  duplicateBadge: string;
  protectedBadge: string;
  discrepancyBadge: string;
  ineligibleBadge: string;
}

export interface InventoryScanInstrumentProps {
  result: RecordInventoryScanResult | null;
  writeFailed: boolean;
  currentDeviceId: string;
  labels: InventoryScanInstrumentLabels;
}

export function InventoryScanInstrument({
  result,
  writeFailed,
  currentDeviceId,
  labels,
}: InventoryScanInstrumentProps) {
  const { i18n } = useTranslation();
  let title: string | null = null;
  let detail: string | null = null;
  let badge: string | null = null;
  let tone: "ok" | "error" | "warn" | "info" = "info";
  if (writeFailed) {
    title = labels.writeFailed;
    tone = "error";
  } else if (result) {
    if (result.verdict === "expected") {
      title =
        result.scanKind === "known_box" ? labels.boxAccepted(result.claimedCount) : labels.expected;
      badge = result.scanKind === "known_box" ? labels.boxBadge : null;
      tone = "ok";
    } else if (result.verdict === "protected") {
      title = labels.protected;
      badge = labels.protectedBadge;
      tone = "error";
    } else if (result.verdict === "known-ineligible") {
      title = labels.ineligible;
      badge = labels.ineligibleBadge;
      tone = "info";
    } else if (result.verdict === "unknown") {
      title = labels.unknown;
      badge = labels.discrepancyBadge;
      tone = "warn";
    } else if (result.verdict === "duplicate") {
      const wonHere = result.firstWinning?.deviceId === currentDeviceId;
      title = wonHere ? labels.duplicateHere : labels.duplicateOther;
      detail = result.firstWinning
        ? `${wonHere ? labels.terminalHere : labels.terminalOther} · ${new Intl.DateTimeFormat(
            i18n.language === "ru" ? "ru-RU" : "en-US",
            { timeStyle: "medium" },
          ).format(new Date(result.firstWinning.scannedAt))}`
        : null;
      badge = labels.duplicateBadge;
      tone = "info";
    } else {
      title = labels.invalid;
      tone = "error";
    }
  }

  return (
    <section className="inventory-scan-instrument" aria-live="polite">
      <div className="inventory-scan-instrument__prompt" aria-hidden="true">
        <span>⌗</span>
      </div>
      <h2>{labels.prompt}</h2>
      <p>{labels.hint}</p>
      {title ? (
        <Alert
          tone={tone}
          title={title}
          action={badge ? <Badge tone={tone === "error" ? "error" : tone}>{badge}</Badge> : null}
        >
          {detail}
        </Alert>
      ) : null}
    </section>
  );
}
