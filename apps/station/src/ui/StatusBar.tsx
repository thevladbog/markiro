import { useTranslation } from "react-i18next";
import { StatusChip } from "@markiro/ui";

export interface StatusBarProps {
  online: boolean;
}

// Persistent floor status bar. Hardware indicators are "not configured"
// placeholders in 05a — the hardware module + workstation setup land in 05b.
export function StatusBar({ online }: StatusBarProps) {
  const { t } = useTranslation();
  const notConfigured = t("shell.notConfigured");
  return (
    <header
      role="contentinfo"
      style={{ display: "flex", gap: 16, alignItems: "center", padding: "8px 16px", fontSize: "1rem" }}
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
      <span>{t("shell.agent")}: <span>{notConfigured}</span></span>
      <span>{t("shell.scanner")}: <span>{notConfigured}</span></span>
      <span>{t("shell.printer")}: <span>{notConfigured}</span></span>
      <span>{t("shell.teammates")}: +0</span>
    </header>
  );
}
