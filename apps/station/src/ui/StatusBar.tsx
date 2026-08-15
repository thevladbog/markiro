import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@markiro/ui";
import type { ServerReachability } from "../lib/api-client.js";

/** What the station can honestly say about its scanner. */
export type ScannerIndicator = "keyboard" | "connected" | "disconnected";
export type FloorConnectivityState = "online" | "offline" | "sync-stuck";
export type UpdateSeverity = "none" | "info" | "warn" | "urgent";

export interface UpdateIndicatorModel {
  severity: UpdateSeverity;
  label: string;
  shortLabel?: string;
  glyph: "↻" | "!";
  available: boolean;
}

export function floorConnectivityState(
  serverReachable: boolean,
  syncStuck: boolean,
): FloorConnectivityState {
  if (syncStuck) return "sync-stuck";
  return serverReachable ? "online" : "offline";
}

export interface StatusBarProps {
  stationName: string;
  lineName: string | null;
  operatorName: string;
  shiftLabel: string | null;
  serverReachability: ServerReachability;
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
  actionsDisabled?: boolean;
  operatorControl?: ReactNode;
  windowControl?: ReactNode;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

// Persistent floor status bar. Scanner/printer indicators reflect the live
// hardware state passed in by App/FloorShell (05b) rather than the hardcoded
// "not configured" placeholders from 05a.
export function StatusBar({
  stationName,
  lineName,
  operatorName,
  shiftLabel,
  serverReachability,
  scanner,
  printerConfigured,
  syncPending,
  syncStuck,
  conflicts,
  update,
  onOpenUpdates,
  actionsDisabled = false,
  operatorControl,
  windowControl,
  collapsed = false,
  onToggleCollapsed,
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
  const connectivityState = floorConnectivityState(serverReachability === "reachable", syncStuck);
  const serverLabel =
    serverReachability === "checking"
      ? t("shell.serverChecking")
      : serverReachability === "reachable"
        ? t("shell.serverAvailable")
        : t("shell.serverUnavailable");
  const updateButton =
    update && onOpenUpdates ? (
      <Button
        size="floor"
        variant="secondary"
        className="station-update-indicator"
        data-update-severity={update.severity}
        aria-label={`${update.glyph} ${update.label}`}
        disabled={actionsDisabled}
        onClick={onOpenUpdates}
        icon={<span aria-hidden="true">{update.glyph}</span>}
      >
        {update.shortLabel ?? update.label}
      </Button>
    ) : null;
  const toggleButton = onToggleCollapsed ? (
    <Button
      size="floor"
      variant="secondary"
      className="station-status-toggle"
      aria-label={t(collapsed ? "shell.expandStatusBar" : "shell.collapseStatusBar")}
      aria-expanded={!collapsed}
      onClick={onToggleCollapsed}
      icon={
        <svg aria-hidden="true" className="station-status-toggle__chevron" viewBox="0 0 18 18">
          <path d={collapsed ? "M4 7l5 5 5-5" : "M4 11l5-5 5 5"} />
        </svg>
      }
    >
      {t(collapsed ? "shell.expandStatusBarShort" : "shell.collapseStatusBarShort")}
    </Button>
  ) : null;

  return (
    <header
      className="station-status-bar"
      aria-label={t("shell.statusBar")}
      data-connectivity-state={connectivityState}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <dl className="station-status-group station-status-group--context">
        {!collapsed ? (
          <StatusValue label={t("shell.station")} value={stationName} testId="station-status" />
        ) : null}
        {lineName ? (
          <StatusValue label={t("shell.line")} value={lineName} testId="line-status" />
        ) : null}
        {!collapsed ? (
          <StatusValue label={t("shell.operator")} value={operatorName} testId="operator-status" />
        ) : null}
        {shiftLabel ? (
          <StatusValue label={t("shell.shift")} value={shiftLabel} testId="shift-status" />
        ) : null}
      </dl>
      <dl className="station-status-group station-status-group--sync">
        <StatusValue
          label={t("shell.server")}
          value={serverLabel}
          {...(serverReachability === "reachable"
            ? { tone: "ok" as const }
            : serverReachability === "unreachable"
              ? { tone: "warn" as const }
              : {})}
          testId="server-status"
          live="polite"
        />
        <StatusValue
          label={t("shell.sync")}
          shortLabel={t("shell.syncShort")}
          value={syncStuck ? `${syncPending} — ${t("shell.syncStuck")}` : String(syncPending)}
          {...(syncStuck ? { tone: "warn" as const } : {})}
          testId="sync-status"
        />
        <StatusValue
          label={t("shell.conflicts")}
          shortLabel={t("shell.conflictsShort")}
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
      {collapsed ? (
        toggleButton
      ) : (
        <div className="station-status-actions" role="group" aria-label={t("shell.stationActions")}>
          {updateButton}
          {operatorControl}
          {windowControl}
          {toggleButton}
        </div>
      )}
    </header>
  );
}

interface StatusValueProps {
  label: string;
  shortLabel?: string;
  value: string;
  testId: string;
  tone?: "ok" | "warn";
  live?: "polite";
}

function StatusValue({ label, shortLabel, value, testId, tone, live }: StatusValueProps) {
  return (
    <div className="station-status-item" data-tone={tone}>
      <dt>
        <span className="station-status-label--long">{label}</span>
        {shortLabel ? <span className="station-status-label--short">{shortLabel}</span> : null}
      </dt>
      <dd data-testid={testId} {...(live ? { role: "status", "aria-live": live } : {})}>
        {value}
      </dd>
    </div>
  );
}
