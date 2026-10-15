import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { FactsFailure, SyncState } from "../app/shell.js";
import type { HardwareApi } from "../hardware/hardware.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readRestoreStatus, type RestoreStatus } from "../local/restore-reconcile.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import { LinkDot } from "./LinkDot.js";
import { FloorWindowControl, type FloorWindowMode } from "./FloorWindowControl.js";
import { OperatorSwitchControl } from "./OperatorSwitchControl.js";
import type { ScanSource } from "./scan-source.js";
import { SyncPanel } from "./SyncPanel.js";
import "./floor-status-bar.css";
import { readStrandedRecords } from "./queue/outbox-recovery.js";
import { useScannerIndicator, type ScannerIndicator } from "./scanner-indicator.js";
import {
  readBlockDrops,
  readDeliveryStuck,
  readOutboxStatus,
  readShiftStock,
  waitUnits,
  type DeliveryStuck,
  type OutboxStatus,
  type SerialStock,
  type ShiftStock,
} from "./outbox-status.js";
import { readShiftCopy } from "./shifts/shift-copies.js";
import { formatQuantity } from "./shifts/shift-text.js";
import type { FloorOperator } from "./sign-in.js";

/**
 * What the rail offers besides «Сменить оператора» (beta 3): the sync panel,
 * and the window mode where this PC can be locked. The scan source and its
 * mute are the badge scan of the identity re-confirmation (`Reconfirm`).
 */
export interface FloorBarTools {
  /** «Повторить сейчас» of the sync panel: asks for a sync and for the outbox to go. */
  retry: () => void;
  /** When the reference sync last finished since the app started. */
  lastSyncedAt: Date | null;
  /** `null` where this PC cannot be locked (a host, an office, a station not configured, development). */
  windowMode: FloorWindowMode | null;
  /** The unmuted scan source. */
  source: ScanSource;
  /** Mutes the floor's screens while a dialog reads a badge. */
  onMute: (muted: boolean) => void;
}

export interface FloorStatusBarProps {
  local: LocalExecutor;
  pairing: Pairing;
  /** The station's line (`DeviceStatus.lineId`). */
  lineId: string | null;
  /** The operator signed in, or `null` on the sign-in screen. */
  operator: FloorOperator | null;
  link: HostStatus | null;
  sync: SyncState;
  /** This device's name as the host has it (`DeviceStatus.deviceName`); `null` for an older pairing file. */
  deviceName: string | null;
  /** The shift the operator works in (`ShellState.floorWork`), or `null`. */
  shiftId: string | null;
  /** The office's change of this device was not saved on this computer (`ShellState.deviceNotSaved`). */
  deviceNotSaved: boolean;
  /**
   * The host refused this station and the refusal waits for the operator to
   * leave the shift (`ShellState.pendingRejection`). The link is down already,
   * but a refusal that came from a call leaves its last status `online`, so the
   * bar has to say it.
   */
  refusalHeld: boolean;
  /**
   * What waits is not a refusal but another host answering at the paired
   * address (`ShellState.pendingOtherHost`); `refusalHeld` is set with it, and
   * only the warning's words differ.
   */
  otherHostHeld?: boolean;
  /**
   * `ShellState.outboxVersion`: the counts of the outbox and the serials left
   * are read again whenever it changes, so whoever writes the floor's work
   * (a record, a block of serials) moves it.
   */
  outboxVersion: number;
  /** `ShellState.factsFailure`: why the last send of the outbox failed; `null` when it did not. */
  factsFailure: FactsFailure | null;
  /** The clock the waits are measured on; this computer's by default. */
  now?: () => Date;
  /**
   * The shell's COM scanners (`HardwareApi.watchScanners`), for the scanner
   * pill; without it the keyboard wedge alone is assumed.
   */
  watchScanners?: HardwareApi["watchScanners"];
  /**
   * «Сменить оператора» in the bar's rail, as on the cloud station; shown only
   * with an operator signed in. The floor leaves (waiting for its work) when it
   * is pressed; in a shift the control asks first.
   */
  onSwitchOperator?: () => void;
  /** The sync panel and the window mode in the rail; without them the rail holds «Сменить оператора» only. */
  tools?: FloorBarTools;
}

const SCANNER_TONE: Readonly<Record<ScannerIndicator, PillTone>> = {
  keyboard: "neutral",
  connected: "ok",
  partial: "warn",
  disconnected: "warn",
  unknown: "neutral",
};

type PillTone = "ok" | "warn" | "neutral";

/**
 * One identity value, after the cloud's `IdentityValue`: the label stays for
 * assistive tech but is not painted, the value is.
 */
function IdentityValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="station-status-item">
      <dt className="station-visually-hidden">{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  );
}

/**
 * One telemetry pill, after the cloud's `StatusPill`: a tone dot, the label,
 * the value right after it (its next element, as the tests read it).
 */
function StatusPill({ label, value, tone }: { label: string; value: string; tone: PillTone }) {
  return (
    <div className="station-status-item station-status-pill" data-tone={tone}>
      <span aria-hidden="true" className="station-status-pill__dot" />
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * How often, while delivery is stuck or the serials are running out, the bar
 * reads the outbox's head and the serials again by itself: a wait grows and
 * the retries count attempts with no write of the floor to say so, and a
 * block of serials arrives without one.
 */
export const REFRESH_MS = 10_000;

const systemClock = (): Date => new Date();

/** A wait as words: `2 ч 5 мин`, `меньше минуты`. */
function waitText(t: TFunction, ms: number): string {
  const parts = waitUnits(ms);
  return parts.length === 0
    ? t("floor.status.wait.none")
    : parts.map((part) => t(`floor.status.wait.${part.unit}`, { n: part.n })).join(" ");
}

/** How long the oldest undelivered record has waited and how often it was sent. */
function stuckText(t: TFunction, stuck: DeliveryStuck): string {
  const age = waitText(t, stuck.waitedMs);
  const attempts = formatQuantity(stuck.attempts);
  return stuck.sinceLastAttemptMs === null
    ? t("floor.status.stuck", { age, attempts })
    : t("floor.status.stuckLast", {
        age,
        attempts,
        last: waitText(t, stuck.sinceLastAttemptMs),
      });
}

/** The warning of a stock of serials below `ok`, in the tone its level calls for. */
function stockAlert(t: TFunction, what: "box" | "pallet", stock: SerialStock) {
  if (stock.level === "ok") return null;
  return (
    <Alert
      tone={stock.level === "last" || stock.level === "none" ? "error" : "warn"}
      role="presentation"
    >
      {t(`floor.status.stock.${what}.${stock.level}`, { n: formatQuantity(stock.left) })}
    </Alert>
  );
}

/**
 * The floor's status bar (stage 1 spec §5.6, plan 1f2), after the cloud
 * station's `StatusBar` (`apps/station/src/ui/StatusBar.tsx`): the
 * organization and the line from the local copies, the operator, and the
 * link to the host with the health of the copies (`HostStatusLine`). It sits
 * above the sign-in screen and the shifts alike, as a labelled region (the
 * app's `main` holds it, so a `header` would not be a landmark). Its one
 * control is «Сменить оператора» in the rail on the right, as on the cloud
 * station (beta feedback, 2026-10-13). Plan 2a5 adds the device's own name, the number of the
 * shift the operator works in, and two warnings in a polite region of their
 * own that is on the screen before either appears (or it would not be heard):
 * a change the office made to this device (its line, its name) that could not
 * be saved on this computer, so the station still works by the old one, and a
 * refusal of this station by the host that waits for the operator to leave
 * the shift. Plan 2a6 adds the outbox — the records not yet sent, refused by
 * the host and in conflict — and, in a shift, the SSCC serials left for its
 * boxes, read again whenever the floor writes. Into the same region go the
 * warnings that a send of the outbox failed (for the host or for this
 * computer; the link's own failure the link's line says) with how long the
 * oldest record has waited and how often it was sent, which stay while
 * the failure does, and that the serials are running out or gone. Plan РК-С
 * adds, in the same region, that a host restored from a copy holds the
 * records, that the station still owes it its blocks, and how many blocks it
 * refused (their serials are no longer used), read with the outbox. Plan ОЧ:
 * the serials of the boxes and, in a shift with pallets, of the pallets, warned
 * at a quarter and a tenth of the newest block, at the last serial and at none;
 * the blocks the host gave that the station did not take; and, as an item, the
 * records an older pairing left unsent. While
 * the host's refusal waits nothing is sent, so the failure of an earlier send
 * is not news. A failed read of the copies leaves the names out, and of the
 * outbox or the serials their figures; the floor works on.
 */
export function FloorStatusBar({
  local,
  pairing,
  lineId,
  operator,
  link,
  sync,
  deviceName,
  shiftId,
  deviceNotSaved,
  refusalHeld,
  otherHostHeld = false,
  outboxVersion,
  factsFailure,
  now = systemClock,
  watchScanners,
  onSwitchOperator,
  tools,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
  const scanner = useScannerIndicator(watchScanners);
  const [place, setPlace] = useState<FloorPlace>({ organization: null, line: null });
  const [shift, setShift] = useState<{ id: string; number: string } | null>(null);
  const { hostId, deviceId } = pairing;

  useEffect(() => {
    if (shiftId === null) return;
    let cancelled = false;
    readShiftCopy(local, { hostId, deviceId }, shiftId).then(
      (copy) => {
        if (!cancelled) setShift(copy === null ? null : { id: copy.id, number: copy.number });
      },
      () => {
        if (!cancelled) setShift(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId]);
  // Only the number of the shift on screen: none after it is left.
  const shiftNumber = shift !== null && shift.id === shiftId ? shift.number : null;

  const [restore, setRestore] = useState<RestoreStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    readRestoreStatus(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setRestore(next);
      },
      () => {
        if (!cancelled) setRestore(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, outboxVersion]);

  const [outbox, setOutbox] = useState<OutboxStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    readOutboxStatus(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setOutbox(next);
      },
      () => {
        if (!cancelled) setOutbox(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, outboxVersion]);

  // While delivery is stuck or the serials are running out the bar reads again on a timer.
  const [tick, setTick] = useState(0);
  const [stock, setStock] = useState<{ shiftId: string; stock: ShiftStock | null } | null>(null);
  useEffect(() => {
    if (shiftId === null) return;
    let cancelled = false;
    readShiftStock(local, { hostId, deviceId }, shiftId).then(
      (next) => {
        if (!cancelled) setStock({ shiftId, stock: next });
      },
      () => {
        if (!cancelled) setStock(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId, outboxVersion, tick]);
  // Only the shift on screen's serials: none after it is left.
  const shiftStock = stock !== null && stock.shiftId === shiftId ? stock.stock : null;
  const serialsRunningOut =
    shiftStock !== null &&
    (shiftStock.boxes.level !== "ok" ||
      (shiftStock.pallets !== null && shiftStock.pallets.level !== "ok"));

  // The blocks the host gave and the station did not take (plan ОЧ), read with
  // the outbox; the records an older pairing left unsent, read once per pairing
  // (a walk of every pairing's unsent records, too dear for every scan).
  const [drops, setDrops] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readBlockDrops(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setDrops(next);
      },
      () => {
        if (!cancelled) setDrops(0);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, outboxVersion]);
  const [stranded, setStranded] = useState(0);
  useEffect(() => {
    let cancelled = false;
    readStrandedRecords(local, { hostId, deviceId }).then(
      (next) => {
        if (!cancelled) setStranded(next);
      },
      () => {
        if (!cancelled) setStranded(0);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId]);

  const failing = factsFailure !== null;
  const [stuck, setStuck] = useState<DeliveryStuck | null>(null);
  useEffect(() => {
    if (!failing) {
      setStuck(null);
      return;
    }
    let cancelled = false;
    readDeliveryStuck(local, { hostId, deviceId }, now()).then(
      (next) => {
        if (!cancelled) setStuck(next);
      },
      () => {
        if (!cancelled) setStuck(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, failing, outboxVersion, tick, now]);

  // A restore reopens the last 30 days of records, so the oldest waiting one
  // is old by weeks while the station has only just begun to send: while the
  // host holds the facts or the station still owes its blocks, the words
  // above say why nothing goes, and a wait of weeks would only alarm.
  const stuckIsRestore = factsFailure === "held" || (restore !== null && restore.due);

  const refreshing = failing || serialsRunningOut;
  useEffect(() => {
    if (!refreshing) return;
    const timer = setInterval(() => setTick((count) => count + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshing]);

  useEffect(() => {
    let cancelled = false;
    readFloorPlace(local, { hostId, deviceId }, lineId).then(
      (next) => {
        if (!cancelled) setPlace(next);
      },
      () => {
        if (!cancelled) setPlace({ organization: null, line: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, lineId, sync.synced]);

  const [syncOpen, setSyncOpen] = useState(false);
  // Something the panel could explain: not the link being down alone, which the
  // line beside it says and an offline factory lives with.
  const syncProblem =
    failing ||
    stranded > 0 ||
    sync.failure !== null ||
    sync.quarantined > 0 ||
    (outbox !== null && (outbox.rejected > 0 || outbox.conflicts > 0 || outbox.displaced > 0));
  const operatorValue = operator === null ? t("floor.status.nobody") : operator.name;
  return (
    <section className="station-status-bar floor-status" aria-label={t("floor.status.label")}>
      {/*
        The cloud station's identity deck (`apps/station/src/ui/StatusBar.tsx`):
        where on the strong first row (the device, the line), who and for whom
        on the quieter second (the operator, the shift, the organization).
      */}
      <dl className="station-status-identity">
        <div className="station-status-identity__row station-status-identity__row--primary">
          {deviceName !== null && (
            <IdentityValue label={t("floor.status.device")} value={deviceName} />
          )}
          {place.line !== null && (
            <IdentityValue label={t("floor.status.line")} value={place.line} />
          )}
        </div>
        <div className="station-status-identity__row station-status-identity__row--secondary">
          <IdentityValue label={t("floor.status.operator")} value={operatorValue} />
          {shiftNumber !== null && (
            <IdentityValue label={t("floor.status.shift")} value={shiftNumber} />
          )}
          {place.organization !== null && (
            <IdentityValue label={t("floor.status.organization")} value={place.organization} />
          )}
        </div>
      </dl>
      <div className="station-status-pills">
        {/*
          While the refusal waits the link is torn down, but a refusal that came
          from a call leaves the last status `online`: say it stopped (a stopped
          link also hides the sync failure it can no longer retry).
        */}
        <LinkDot
          status={refusalHeld && link !== null ? { ...link, state: "offline" } : link}
          sync={sync}
        />
        <dl className="station-status-pills__list">
          {shiftStock !== null && (
            <StatusPill
              label={t("floor.status.serials")}
              value={formatQuantity(shiftStock.boxes.left)}
              tone={shiftStock.boxes.level === "ok" ? "ok" : "warn"}
            />
          )}
          {shiftStock !== null && shiftStock.pallets !== null && (
            <StatusPill
              label={t("floor.status.palletSerials")}
              value={formatQuantity(shiftStock.pallets.left)}
              tone={shiftStock.pallets.level === "ok" ? "ok" : "warn"}
            />
          )}
          {outbox !== null && (
            <StatusPill
              label={t("floor.status.unsent")}
              value={formatQuantity(outbox.unsent)}
              tone={failing ? "warn" : "ok"}
            />
          )}
          {outbox !== null && outbox.rejected > 0 && (
            <StatusPill
              label={t("floor.status.rejected")}
              value={formatQuantity(outbox.rejected)}
              tone="warn"
            />
          )}
          {outbox !== null && outbox.conflicts > 0 && (
            <StatusPill
              label={t("floor.status.conflicts")}
              value={formatQuantity(outbox.conflicts)}
              tone="warn"
            />
          )}
          {outbox !== null && outbox.displaced > 0 && (
            <StatusPill
              label={t("floor.status.displaced")}
              value={formatQuantity(outbox.displaced)}
              tone="warn"
            />
          )}
          {stranded > 0 && (
            <StatusPill
              label={t("floor.status.stranded")}
              value={formatQuantity(stranded)}
              tone="warn"
            />
          )}
          <StatusPill
            label={t("floor.status.scanner")}
            value={t(`floor.status.scannerValue.${scanner}`)}
            tone={SCANNER_TONE[scanner]}
          />
        </dl>
      </div>
      {(tools !== undefined || (operator !== null && onSwitchOperator !== undefined)) && (
        <div className="station-status-actions" role="group" aria-label={t("floor.status.actions")}>
          {tools !== undefined && (
            <Button
              type="button"
              size="floor"
              variant="secondary"
              className="station-rail-button station-rail-button--icon floor-sync-button"
              aria-label={t(syncProblem ? "floor.sync.openProblems" : "floor.sync.open")}
              title={t("floor.sync.open")}
              data-problem={syncProblem ? "true" : "false"}
              onClick={() => setSyncOpen(true)}
              icon={
                <span aria-hidden="true" className="floor-sync-button__glyph">
                  ↻
                </span>
              }
            >
              {syncProblem && <span className="floor-sync-button__dot" aria-hidden="true" />}
            </Button>
          )}
          {tools?.windowMode != null && (
            <FloorWindowControl
              windowMode={tools.windowMode}
              local={local}
              pairing={pairing}
              source={tools.source}
              onMute={tools.onMute}
              operatorId={operator === null ? null : operator.id}
            />
          )}
          {operator !== null && onSwitchOperator !== undefined && (
            <OperatorSwitchControl activeShift={shiftId !== null} onSwitch={onSwitchOperator} />
          )}
        </div>
      )}
      {tools !== undefined && (
        <SyncPanel
          open={syncOpen}
          onClose={() => setSyncOpen(false)}
          local={local}
          pairing={pairing}
          link={link}
          sync={sync}
          factsFailure={factsFailure}
          refusalHeld={refusalHeld}
          outboxVersion={outboxVersion}
          lastSyncedAt={tools.lastSyncedAt}
          onRetry={tools.retry}
          now={now}
        />
      )}
      {/*
        Its own polite region, there before the warnings so that they are
        heard; the warnings are not alerts as well (`role="presentation"`
        drops the component's own role), or each would be read twice. A row
        of its own under the bar, the full width, empty and flat until a
        warning comes.
      */}
      <div className="station-status-alerts floor-status__alerts" aria-live="polite">
        {refusalHeld && (
          <Alert tone="error" role="presentation">
            {t(otherHostHeld ? "floor.status.otherHostHeld" : "floor.status.refusalHeld")}
          </Alert>
        )}
        {deviceNotSaved && (
          <Alert tone="warn" role="presentation">
            {t("floor.status.deviceNotSaved")}
          </Alert>
        )}
        {!refusalHeld && factsFailure === "host" && (
          <Alert tone="warn" role="presentation">
            {t("floor.status.factsHost")}
          </Alert>
        )}
        {!refusalHeld && factsFailure === "held" && (
          <Alert tone="warn" role="presentation">
            {t("floor.status.restoreHeld")}
          </Alert>
        )}
        {!refusalHeld && restore !== null && restore.due && (
          <Alert tone="warn" role="presentation">
            {t("floor.status.restoreDue")}
          </Alert>
        )}
        {restore !== null && restore.refused > 0 && (
          <Alert tone="error" role="presentation">
            {t("floor.status.restoreRefused", { n: restore.refused })}
          </Alert>
        )}
        {!refusalHeld && factsFailure === "local" && (
          <Alert tone="warn" role="presentation">
            {t("floor.status.factsLocal")}
          </Alert>
        )}
        {!refusalHeld && !stuckIsRestore && stuck !== null && (
          <Alert tone="warn" role="presentation">
            {stuckText(t, stuck)}
          </Alert>
        )}
        {shiftStock !== null && stockAlert(t, "box", shiftStock.boxes)}
        {shiftStock !== null &&
          shiftStock.pallets !== null &&
          stockAlert(t, "pallet", shiftStock.pallets)}
        {drops > 0 && (
          <Alert tone="error" role="presentation">
            {t("floor.status.blockDrops", { n: formatQuantity(drops) })}
          </Alert>
        )}
      </div>
    </section>
  );
}
