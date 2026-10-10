import { useEffect, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { FactsFailure, SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import {
  readDeliveryStuck,
  readOutboxStatus,
  readSerialsLeft,
  SERIALS_LOW,
  waitUnits,
  type DeliveryStuck,
  type OutboxStatus,
} from "./outbox-status.js";
import { readShiftCopy } from "./shifts/shift-copies.js";
import { formatQuantity } from "./shifts/shift-text.js";
import type { FloorOperator } from "./sign-in.js";

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
   * `ShellState.outboxVersion`: the counts of the outbox and the serials left
   * are read again whenever it changes, so whoever writes the floor's work
   * (a record, a block of serials) moves it.
   */
  outboxVersion: number;
  /** `ShellState.factsFailure`: why the last send of the outbox failed; `null` when it did not. */
  factsFailure: FactsFailure | null;
  /** The clock the waits are measured on; this computer's by default. */
  now?: () => Date;
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

/**
 * The floor's status bar (stage 1 spec §5.6, plan 1f2), after the cloud
 * station's `StatusBar` (`apps/station/src/ui/StatusBar.tsx`): the
 * organization and the line from the local copies, the operator, and the
 * link to the host with the health of the copies (`HostStatusLine`). It sits
 * above the sign-in screen and the shifts alike, as a labelled region (the
 * app's `main` holds it, so a `header` would not be a landmark), and holds
 * nothing to press. Plan 2a5 adds the device's own name, the number of the
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
 * the failure does, and that the serials are running out or gone. While
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
  outboxVersion,
  factsFailure,
  now = systemClock,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
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
  const [serials, setSerials] = useState<{ shiftId: string; left: number | null } | null>(null);
  useEffect(() => {
    if (shiftId === null) return;
    let cancelled = false;
    readSerialsLeft(local, { hostId, deviceId }, shiftId).then(
      (left) => {
        if (!cancelled) setSerials({ shiftId, left });
      },
      () => {
        if (!cancelled) setSerials(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [local, hostId, deviceId, shiftId, outboxVersion, tick]);
  // Only the shift on screen's serials: none after it is left.
  const serialsLeft = serials !== null && serials.shiftId === shiftId ? serials.left : null;
  const serialsRunningOut = serialsLeft !== null && serialsLeft <= SERIALS_LOW;

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

  return (
    <section className="floor-status" aria-label={t("floor.status.label")}>
      <dl className="floor-status__identity">
        {deviceName !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.device")}</dt>
            <dd>{deviceName}</dd>
          </div>
        )}
        {place.organization !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.organization")}</dt>
            <dd>{place.organization}</dd>
          </div>
        )}
        {place.line !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.line")}</dt>
            <dd>{place.line}</dd>
          </div>
        )}
        <div className="floor-status__item">
          <dt>{t("floor.status.operator")}</dt>
          <dd>
            {operator === null
              ? t("floor.status.nobody")
              : t("floor.status.operatorValue", { name: operator.name, login: operator.login })}
          </dd>
        </div>
        {shiftNumber !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.shift")}</dt>
            <dd>{shiftNumber}</dd>
          </div>
        )}
        {serialsLeft !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.serials")}</dt>
            <dd>{formatQuantity(serialsLeft)}</dd>
          </div>
        )}
        {outbox !== null && (
          <div className="floor-status__item">
            <dt>{t("floor.status.unsent")}</dt>
            <dd>{formatQuantity(outbox.unsent)}</dd>
          </div>
        )}
        {outbox !== null && outbox.rejected > 0 && (
          <div className="floor-status__item">
            <dt>{t("floor.status.rejected")}</dt>
            <dd>{formatQuantity(outbox.rejected)}</dd>
          </div>
        )}
        {outbox !== null && outbox.conflicts > 0 && (
          <div className="floor-status__item">
            <dt>{t("floor.status.conflicts")}</dt>
            <dd>{formatQuantity(outbox.conflicts)}</dd>
          </div>
        )}
      </dl>
      <div className="floor-status__health">
        {/*
          While the refusal waits the link is torn down, but a refusal that came
          from a call leaves the last status `online`: say it stopped (a stopped
          link also hides the sync failure it can no longer retry).
        */}
        <HostStatusLine
          status={refusalHeld && link !== null ? { ...link, state: "offline" } : link}
          sync={sync}
        />
        {/*
          Its own polite region, there before the warnings so that they are
          heard; the warnings are not alerts as well (`role="presentation"`
          drops the component's own role), or each would be read twice.
        */}
        <div className="floor-status__alerts" aria-live="polite">
          {refusalHeld && (
            <Alert tone="error" role="presentation">
              {t("floor.status.refusalHeld")}
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
          {!refusalHeld && factsFailure === "local" && (
            <Alert tone="warn" role="presentation">
              {t("floor.status.factsLocal")}
            </Alert>
          )}
          {!refusalHeld && stuck !== null && (
            <Alert tone="warn" role="presentation">
              {stuckText(t, stuck)}
            </Alert>
          )}
          {serialsLeft !== null && serialsLeft === 0 && (
            <Alert tone="error" role="presentation">
              {t("floor.status.serialsNone")}
            </Alert>
          )}
          {serialsLeft !== null && serialsLeft > 0 && serialsLeft <= SERIALS_LOW && (
            <Alert tone="warn" role="presentation">
              {t("floor.status.serialsLow", { n: serialsLeft })}
            </Alert>
          )}
        </div>
      </div>
    </section>
  );
}
