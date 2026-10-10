import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Alert } from "@markiro/ui";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
import { readShiftCopy } from "./shifts/shift-copies.js";
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
 * the shift. A failed read of the copies leaves the names out; the floor
 * works on.
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
      </dl>
      <div className="floor-status__health">
        <HostStatusLine status={link} sync={sync} />
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
        </div>
      </div>
    </section>
  );
}
