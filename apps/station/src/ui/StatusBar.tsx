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
      {/*
        The identity deck: what/where on the strong first row, who/which shift
        on the quieter second. Labels stay in the DOM for assistive tech but
        are not painted -- «Станция упаковки готовой продукции 01» does not
        need the word «Станция» in front of it, and the freed width is exactly
        what let the values stop truncating to three letters on wide screens.
      */}
      <dl className="station-status-identity">
        <div className="station-status-identity__row station-status-identity__row--primary">
          {!collapsed ? (
            <IdentityValue label={t("shell.station")} value={stationName} testId="station-status" />
          ) : null}
          {lineName ? (
            <IdentityValue label={t("shell.line")} value={lineName} testId="line-status" />
          ) : null}
        </div>
        <div className="station-status-identity__row station-status-identity__row--secondary">
          {!collapsed ? (
            <IdentityValue
              label={t("shell.operator")}
              value={operatorName}
              testId="operator-status"
            />
          ) : null}
          {shiftLabel ? (
            <IdentityValue label={t("shell.shift")} value={shiftLabel} testId="shift-status" />
          ) : null}
        </div>
      </dl>
      {/*
        Telemetry pills. Each carries a tone dot; the VALUE is painted only
        when it says something a green dot cannot («7 — Не уходит», «Нет
        сигнала») or when it is a number worth watching. Healthy states read
        as colour in half a glance instead of five words of prose. Every value
        stays in the DOM regardless -- screen readers and tests see the same
        facts at every viewport.
      */}
      <dl className="station-status-pills">
        <StatusPill
          label={t("shell.server")}
          value={serverLabel}
          tone={
            serverReachability === "reachable"
              ? "ok"
              : serverReachability === "unreachable"
                ? "warn"
                : "neutral"
          }
          valueShown={serverReachability !== "reachable"}
          testId="server-status"
          live="polite"
        />
        <StatusPill
          label={t("shell.sync")}
          shortLabel={t("shell.syncShort")}
          value={syncStuck ? `${syncPending} — ${t("shell.syncStuck")}` : String(syncPending)}
          tone={syncStuck ? "warn" : "ok"}
          valueShown
          testId="sync-status"
        />
        <StatusPill
          label={t("shell.conflicts")}
          shortLabel={t("shell.conflictsShort")}
          value={String(conflicts)}
          tone="neutral"
          valueShown
          testId="conflicts-status"
        />
        <StatusPill
          label={t("shell.scanner")}
          value={scannerLabel}
          tone={scanner === "connected" ? "ok" : scanner === "disconnected" ? "warn" : "neutral"}
          valueShown={scanner !== "connected"}
          testId="scanner-status"
        />
        <StatusPill
          label={t("shell.printer")}
          value={printerConfigured ? printerConfiguredLabel : notConfigured}
          tone={printerConfigured ? "ok" : "neutral"}
          valueShown={!printerConfigured}
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

interface IdentityValueProps {
  label: string;
  value: string;
  testId: string;
}

function IdentityValue({ label, value, testId }: IdentityValueProps) {
  return (
    <div className="station-status-item">
      <dt className="station-visually-hidden">{label}</dt>
      <dd data-testid={testId} title={value}>
        {value}
      </dd>
    </div>
  );
}

interface StatusPillProps {
  label: string;
  shortLabel?: string;
  value: string;
  testId: string;
  tone: "ok" | "warn" | "neutral";
  /** Paint the value next to the label; false leaves it to the dot (and AT). */
  valueShown?: boolean;
  live?: "polite";
}

function StatusPill({ label, shortLabel, value, testId, tone, valueShown, live }: StatusPillProps) {
  return (
    <div
      className="station-status-item station-status-pill"
      data-tone={tone}
      data-value-shown={valueShown ? "true" : "false"}
    >
      <span aria-hidden="true" className="station-status-pill__dot" />
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
