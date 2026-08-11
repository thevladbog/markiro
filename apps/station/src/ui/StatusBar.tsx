import { useTranslation } from "react-i18next";

/** What the station can honestly say about its scanner. */
export type ScannerIndicator = "keyboard" | "connected" | "disconnected";
export type FloorConnectivityState = "online" | "offline" | "sync-stuck";
export type UpdateSeverity = "none" | "info" | "warn" | "urgent";

export interface UpdateIndicatorModel {
  severity: UpdateSeverity;
  label: string;
  glyph: "↻" | "!";
  available: boolean;
}

export function floorConnectivityState(
  online: boolean,
  syncStuck: boolean,
): FloorConnectivityState {
  if (syncStuck) return "sync-stuck";
  return online ? "online" : "offline";
}

export interface StatusBarProps {
  stationName: string;
  lineName: string | null;
  operatorName: string;
  shiftLabel: string | null;
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
  update?: UpdateIndicatorModel;
  onOpenUpdates?: () => void;
}

// Persistent floor status bar. Scanner/printer indicators reflect the live
// hardware state passed in by App/FloorShell (05b) rather than the hardcoded
// "not configured" placeholders from 05a.
export function StatusBar({
  stationName,
  lineName,
  operatorName,
  shiftLabel,
  online,
  scanner,
  printerConfigured,
  syncPending,
  syncStuck,
  conflicts,
  update,
  onOpenUpdates,
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
  const connectivityState = floorConnectivityState(online, syncStuck);
  return (
    <header
      className="station-status-bar"
      aria-label={t("shell.statusBar")}
      data-connectivity-state={connectivityState}
    >
      <dl className="station-status-group station-status-group--context">
        <StatusValue label={t("shell.station")} value={stationName} testId="station-status" />
        {lineName ? (
          <StatusValue label={t("shell.line")} value={lineName} testId="line-status" />
        ) : null}
        <StatusValue label={t("shell.operator")} value={operatorName} testId="operator-status" />
        {shiftLabel ? (
          <StatusValue label={t("shell.shift")} value={shiftLabel} testId="shift-status" />
        ) : null}
      </dl>
      <dl className="station-status-group station-status-group--sync">
        <StatusValue
          label={t("shell.network")}
          value={online ? t("shell.online") : t("shell.offline")}
          tone={online ? "ok" : "warn"}
          testId="network-status"
        />
        <StatusValue
          label={t("shell.sync")}
          value={syncStuck ? `${syncPending} — ${t("shell.syncStuck")}` : String(syncPending)}
          {...(syncStuck ? { tone: "warn" as const } : {})}
          testId="sync-status"
        />
        <StatusValue
          label={t("shell.conflicts")}
          value={String(conflicts)}
          testId="conflicts-status"
        />
      </dl>
      <dl className="station-status-group station-status-group--hardware">
        <StatusValue
          label={t("shell.scanner")}
          value={scannerLabel}
          {...(scanner === "disconnected" ? { tone: "warn" as const } : {})}
          testId="scanner-status"
        />
        <StatusValue
          label={t("shell.printer")}
          value={printerConfigured ? printerConfiguredLabel : notConfigured}
          testId="printer-status"
        />
      </dl>
      {update && onOpenUpdates ? (
        <button
          type="button"
          className="station-update-indicator"
          data-update-severity={update.severity}
          aria-label={`${update.glyph} ${update.label}`}
          onClick={onOpenUpdates}
        >
          <span aria-hidden="true">{update.glyph}</span>
          <span>{update.label}</span>
        </button>
      ) : null}
    </header>
  );
}

interface StatusValueProps {
  label: string;
  value: string;
  testId: string;
  tone?: "ok" | "warn";
}

function StatusValue({ label, value, testId, tone }: StatusValueProps) {
  return (
    <div className="station-status-item" data-tone={tone}>
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}
