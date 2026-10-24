import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert, Button } from "@markiro/ui";

import type { FactsFailure, SyncState } from "../app/shell.js";
import type { HardwareApi } from "../hardware/hardware.js";
import type { DeviceLicense, HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import type { HostUpdateOffer } from "../update/host-offer.js";
import { readRestoreStatus, type RestoreStatus } from "../local/restore-reconcile.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import { emergencyEndsAt, floorLicenseLine } from "./license.js";
import { isDemoShiftNumber } from "./demo/demo-codes.js";
import { FloorChip } from "./FloorChip.js";
import { LinkDot } from "./LinkDot.js";
import { FloorUpdateLine } from "./FloorUpdateLine.js";
import { FloorWindowControl, type FloorWindowMode } from "./FloorWindowControl.js";
import {
  chipForm,
  chipKinds,
  linkChip,
  operatorForm,
  printerChip,
  queueChips,
  scannerChip,
  type ChipKind,
  type HeaderChip,
  type HeaderScreen,
} from "./header-chips.js";
import { Glyph } from "./kit/StatusIcons.js";
import { OperatorSwitchControl } from "./OperatorSwitchControl.js";
import { usePrinterState } from "./printer-indicator.js";
import type { ScanSource } from "./scan-source.js";
import { SyncPanel } from "./SyncPanel.js";
import "./floor-status-bar.css";
import { readStrandedRecords } from "./queue/outbox-recovery.js";
import { useScannerIndicator } from "./scanner-indicator.js";
import { useHeaderCollapse } from "./use-header-collapse.js";
import {
  readBlockDrops,
  readDeliveryStuck,
  readOutboxStatus,
  readShiftStock,
  waitUnits,
  type DeliveryStuck,
  type OutboxStatus,
  type ShiftStock,
} from "./outbox-status.js";
import { readShiftCopy } from "./shifts/shift-copies.js";
import { formatQuantity } from "./shifts/shift-text.js";
import type { FloorOperator } from "./sign-in.js";
import { stockChipDetail, stockChipTone } from "./stock-text.js";

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
  /**
   * The site's license as the station last heard it (`useStationLicense`,
   * plan ЛЦ-3); `null` (the default) — nothing to say.
   */
  license?: DeviceLicense | null;
  /** The update the host offers this station (plan ОБН-3); none by default. */
  updateOffer?: HostUpdateOffer;
  /**
   * The clock the waits are measured on, and the end of the license's
   * emergency extension; this computer's by default.
   */
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
  /**
   * Which chips the screen shows (`chipKinds`): sign-in the link and the scanner, the hub and the
   * forms the link, the printer and the scanner, the work screen all four. Without it: no operator
   * is sign-in, an operator in a shift is work, any other is hub.
   */
  screen?: HeaderScreen;
}

/**
 * One identity value, after the cloud's `IdentityValue`: the label stays for
 * assistive tech but is not painted, the value is.
 */
function IdentityValue({
  label,
  value,
  keep = false,
}: {
  label: string;
  value: string;
  /** Does not shrink with an ellipsis before the others (the shift's number). */
  keep?: boolean;
}) {
  return (
    <div className={keep ? "station-status-item station-status-item--keep" : "station-status-item"}>
      <dt className="station-visually-hidden">{label}</dt>
      <dd title={value}>{value}</dd>
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

const NO_UPDATE: HostUpdateOffer = { kind: "none" };

/** The longest delay `setTimeout` keeps (a signed 32-bit number of milliseconds). */
const MAX_TIMER_MS = 2_147_483_647;

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
 * records an older pairing left unsent. Plan ЛЦ-3: the site's license, quietly
 * (`floorLicenseLine`): nothing while new shifts open, the grace with its last
 * day, that no new shift opens, or the emergency extension with its end; the
 * line never stops the work on screen. Plan ОБН-3 adds, off a shift's work
 * only, that a new version waits for an administrator, or that the host
 * refuses this station already. While
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
  license = null,
  updateOffer = NO_UPDATE,
  now = systemClock,
  watchScanners,
  onSwitchOperator,
  tools,
  screen: screenProp,
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
  const stockTone = stockChipTone(shiftStock);
  const serialsRunningOut = stockTone !== null;

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

  // The license's line (plan ЛЦ-3). The emergency extension is said only
  // while its end is ahead by this computer's clock, so the bar renders
  // again at that end by itself: offline, no new read of the host would.
  const [licenseTick, setLicenseTick] = useState(0);
  const emergencyEnd = emergencyEndsAt(license);
  useEffect(() => {
    if (emergencyEnd === null) return;
    const wait = emergencyEnd - now().getTime();
    if (wait <= 0) return;
    // A timer longer than a signed 32-bit delay fires at once: wait in steps;
    // one that fires early renders the extension again and waits once more.
    const timer = setTimeout(
      () => setLicenseTick((count) => count + 1),
      Math.min(wait + 1, MAX_TIMER_MS),
    );
    return () => clearTimeout(timer);
  }, [emergencyEnd, now, licenseTick]);
  const licenseLine = floorLicenseLine(license, now());

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

  // The chips (kit header): which ones the screen shows, and what each says now.
  const screen: HeaderScreen =
    screenProp ?? (operator === null ? "sign-in" : shiftId !== null ? "work" : "hub");
  const kinds = chipKinds(screen);
  const printerState = usePrinterState(local, pairing, shiftId, outboxVersion, tick);
  const count = (key: string, n: number): string => `${t(key)}: ${formatQuantity(n)}`;
  const counted: Array<{ chip: HeaderChip; title: string }> = [];
  if (kinds.includes("printer") && printerState !== null) {
    const chip = printerChip(printerState);
    counted.push({ chip, title: t(`floor.chips.printer.${chip.text}`) });
  }
  const scannerSign = scannerChip(scanner);
  counted.push({
    chip: scannerSign,
    title: `${t("floor.status.scanner")}: ${t(`floor.status.scannerValue.${scanner}`)}`,
  });
  if (kinds.includes("queue") && outbox !== null) {
    for (const chip of queueChips({
      unsent: outbox.unsent,
      rejected: outbox.rejected,
      failing,
    })) {
      counted.push({
        chip,
        title: count(
          chip.kind === "queue" ? "floor.status.unsent" : "floor.status.rejected",
          chip.n ?? 0,
        ),
      });
    }
  }
  // What the design has no place for and the old bar always said: a conflict, a displaced code, the
  // records an older pairing left unsent. Rare, a warning each, with their words.
  const problems: Array<[ChipKind, number, string]> = [];
  if (outbox !== null) {
    problems.push(["conflicts", outbox.conflicts, "floor.status.conflicts"]);
    problems.push(["displaced", outbox.displaced, "floor.status.displaced"]);
  }
  problems.push(["stranded", stranded, "floor.status.stranded"]);
  for (const [kind, n, label] of problems) {
    if (n > 0) {
      counted.push({
        chip: { kind, tone: "warn", icon: "stock", text: "count", n },
        title: count(label, n),
      });
    }
  }
  const chipText = (chip: HeaderChip): string =>
    t(`floor.chips.${chip.kind}.${chip.text}`, {
      n: chip.n === undefined ? "" : formatQuantity(chip.n),
    });
  const linkSign = linkChip(
    refusalHeld && link !== null ? { ...link, state: "offline" } : link,
    sync,
  );
  const content = [
    operatorValue,
    deviceName ?? "",
    place.line ?? "",
    place.organization ?? "",
    shiftNumber ?? "",
    stockTone ?? "",
    [linkSign, ...counted.map((entry) => entry.chip)]
      .map((chip) => `${chip.kind}:${chip.tone}:${chip.text}:${chip.n ?? ""}`)
      .join(","),
  ].join("|");
  const { ref: barRef, level } = useHeaderCollapse(screen, content);
  return (
    <section
      ref={barRef}
      className="station-status-bar floor-status"
      aria-label={t("floor.status.label")}
    >
      {/*
        The identity deck, after the cloud station's (`apps/station/src/ui/StatusBar.tsx`): where
        on the quiet first row (the device, the line), who on the strong second (the operator, the
        shift, the organization).
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
            <IdentityValue label={t("floor.status.shift")} value={shiftNumber} keep />
          )}
          {place.organization !== null && (
            <IdentityValue label={t("floor.status.organization")} value={place.organization} />
          )}
        </div>
      </dl>
      <div className="floor-bar__rail">
        <div className="station-status-pills" role="group" aria-label={t("floor.chips.label")}>
          {/*
            While the refusal waits the link is torn down, but a refusal that came from a call
            leaves the last status `online`: say it stopped (a stopped link also hides the sync
            failure it can no longer retry).
          */}
          <LinkDot
            status={refusalHeld && link !== null ? { ...link, state: "offline" } : link}
            sync={sync}
            level={level}
          />
          {counted.map(({ chip, title }) => (
            <FloorChip
              key={chip.kind}
              kind={chip.kind}
              tone={chip.tone}
              icon={chip.icon}
              text={chipText(chip)}
              form={chipForm(level, chip.tone)}
              title={title}
            />
          ))}
          {/*
            The one header trace of the SSCC serials running out (the counts live in the sync
            panel). A polite region that is there before the chip comes, so the warning is heard;
            `display: contents` keeps it out of the row's layout. The detail is read, not painted:
            the chip stays short.
          */}
          {/* A demo shift (spec 2026-10-21): its codes and labels are no production's. */}
          {isDemoShiftNumber(shiftNumber) && (
            <FloorChip
              kind="demo"
              tone="warn"
              icon="barcode"
              text={t("floor.demo.chip")}
              form="full"
            />
          )}
          <div className="floor-stock-chip-region" aria-live="polite">
            {stockTone !== null && shiftStock !== null && (
              <div
                className="floor-chip floor-stock-chip"
                data-chip="stock"
                data-tone={stockTone}
                data-form="full"
                title={stockChipDetail(t, shiftStock)}
              >
                <Glyph name="stock" size={22} />
                <span className="floor-chip__text">{t("floor.status.stockLow")}</span>
                <span className="station-visually-hidden">{stockChipDetail(t, shiftStock)}</span>
              </div>
            )}
          </div>
        </div>
        {(tools !== undefined || (operator !== null && onSwitchOperator !== undefined)) && (
          <div
            className="station-status-actions"
            role="group"
            aria-label={t("floor.status.actions")}
          >
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
                icon={<Glyph name="refresh" size={28} />}
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
              <OperatorSwitchControl
                activeShift={shiftId !== null}
                onSwitch={onSwitchOperator}
                form={operatorForm(level)}
              />
            )}
          </div>
        )}
      </div>
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
          stock={shiftStock}
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
        <FloorUpdateLine
          offer={updateOffer}
          appTooOld={link?.lastError === "app_too_old"}
          inShift={shiftId !== null}
        />
        {licenseLine !== null && (
          <Alert tone={licenseLine.tone} role="presentation">
            {t(licenseLine.key, licenseLine.values ?? {})}
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
        {drops > 0 && (
          <Alert tone="error" role="presentation">
            {t("floor.status.blockDrops", { n: formatQuantity(drops) })}
          </Alert>
        )}
      </div>
    </section>
  );
}
