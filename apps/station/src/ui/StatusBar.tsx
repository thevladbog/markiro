import { useTranslation } from "react-i18next";
import { StatusChip } from "@markiro/ui";

/** What the station can honestly say about its scanner. */
export type ScannerIndicator = "keyboard" | "connected" | "disconnected";

export interface StatusBarProps {
  online: boolean;
  scanner: ScannerIndicator;
  printerConfigured: boolean;
}

// Persistent floor status bar. Scanner/printer indicators reflect the live
// hardware state passed in by App/FloorShell (05b) rather than the hardcoded
// "not configured" placeholders from 05a.
export function StatusBar({ online, scanner, printerConfigured }: StatusBarProps) {
  const { t } = useTranslation();
  const notConfigured = t("shell.notConfigured");
  const connected = t("shell.connected");
  // A printer cannot be proven alive without printing to it, so it gets its
  // own "configured" label rather than borrowing the scanner's "Connected" --
  // which IS confirmed, by the Rust-side `station://scanner-status` event.
  const printerConfiguredLabel = t("shell.printerConfigured");
  // A keyboard wedge is indistinguishable from a keyboard, so "keyboard" is
  // the honest label when no serial scanner is configured — it neither claims
  // a device we cannot see nor implies nothing works.
  const scannerLabel =
    scanner === "connected"
      ? connected
      : scanner === "disconnected"
        ? t("shell.scannerDisconnected")
        : t("shell.scannerKeyboard");
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
          of "Agent: Not configured" would never equal the exact string.
          Each value span also carries a stable data-testid: several fields
          can render the same words ("Connected", "Not configured") at once,
          so a text-only query would be ambiguous across fields. */}
      <span>
        {t("shell.agent")}: <span data-testid="agent-status">{notConfigured}</span>
      </span>
      <span>
        {t("shell.scanner")}: <span data-testid="scanner-status">{scannerLabel}</span>
      </span>
      <span>
        {t("shell.printer")}:{" "}
        <span data-testid="printer-status">
          {printerConfigured ? printerConfiguredLabel : notConfigured}
        </span>
      </span>
      <span>{t("shell.teammates")}: +0</span>
    </header>
  );
}
