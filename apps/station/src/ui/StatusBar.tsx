import { useTranslation } from "react-i18next";
import { StatusChip } from "@markiro/ui";

/** What the station can honestly say about its scanner. */
export type ScannerIndicator = "keyboard" | "connected" | "disconnected";

export interface StatusBarProps {
  online: boolean;
  scanner: ScannerIndicator;
  printerConfigured: boolean;
  /** Scans queued on this device, not yet accepted by the server. */
  syncPending: number;
  /** The queue has work and has stopped moving — see sync.ts's STUCK_AFTER_MS. */
  syncStuck: boolean;
  /**
   * Codes this device scanned that an earlier scan elsewhere already owns
   * (see conflicts.ts's conflictCount). A quiet, always-present count — never
   * a badge, never a modal, never anything competing with a scan verdict.
   */
  conflicts: number;
}

// Persistent floor status bar. Scanner/printer indicators reflect the live
// hardware state passed in by App/FloorShell (05b) rather than the hardcoded
// "not configured" placeholders from 05a.
export function StatusBar({
  online,
  scanner,
  printerConfigured,
  syncPending,
  syncStuck,
  conflicts,
}: StatusBarProps) {
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
      <span>
        {t("shell.sync")}:{" "}
        {/* A rising number while offline is information, not a problem — the
            station is offline-first. Only a queue that has STOPPED MOVING is
            worth an operator's attention. */}
        <span data-testid="sync-status">
          {syncStuck ? `${syncPending} — ${t("shell.syncStuck")}` : String(syncPending)}
        </span>
      </span>
      {/* Quiet on purpose: no color, no icon, no distinct treatment from any
          other status field — this is not an alarm, and the operator already
          saw a scan verdict for these minutes ago (see the floor rule this
          screen exists under, in the 06b design brief). Reachable detail
          lives in ConflictList, opened deliberately from shift selection. */}
      <span>
        {t("shell.conflicts")}: <span data-testid="conflicts-status">{String(conflicts)}</span>
      </span>
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
