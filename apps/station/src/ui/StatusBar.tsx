import { useTranslation } from "react-i18next";
import { StatusChip } from "@markiro/ui";

export interface StatusBarProps {
  online: boolean;
  scannerConnected: boolean;
  printerConfigured: boolean;
}

// Persistent floor status bar. Scanner/printer indicators reflect the live
// hardware state passed in by App/FloorShell (05b) rather than the hardcoded
// "not configured" placeholders from 05a.
export function StatusBar({ online, scannerConnected, printerConfigured }: StatusBarProps) {
  const { t } = useTranslation();
  const notConfigured = t("shell.notConfigured");
  const connected = t("shell.connected");
  return (
    <header
      style={{
        display: "flex",
        gap: 16,
        alignItems: "center",
        padding: "8px 16px",
        fontSize: "1rem",
      }}
    >
      {/* StatusChipProps omits `children` (it extends HTMLAttributes minus
          "children"), so the copy is passed via `label`, not JSX children. */}
      <StatusChip
        status={online ? "ok" : "warn"}
        label={online ? t("shell.online") : t("shell.offline")}
      />
      <span>{t("shell.sync")}: 0</span>
      {/* The value is wrapped in its own <span> (not just interpolated
          inline) so "Not configured" is one element's exact text content —
          Testing Library's getByText matches per-element, and a shared span
          of "Agent: Not configured" would never equal the exact string. */}
      <span>
        {t("shell.agent")}: <span>{notConfigured}</span>
      </span>
      <span>
        {t("shell.scanner")}: <span>{scannerConnected ? connected : notConfigured}</span>
      </span>
      <span>
        {t("shell.printer")}: <span>{printerConfigured ? connected : notConfigured}</span>
      </span>
      <span>{t("shell.teammates")}: +0</span>
    </header>
  );
}
