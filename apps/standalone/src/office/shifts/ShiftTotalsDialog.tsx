import type { TFunction } from "i18next";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, DefinitionGrid, Modal } from "@markiro/ui";

import type { DeviceRecord, DeviceTotals, OfficeShift } from "../../host/protocol.js";
import { isKnownTimeZone } from "../../lib/civil-date.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { LoadError, PageLoading } from "../page-state.js";

/** Counts with the thousands apart by a no-break space, as Russian writes them: «1 200». */
const UNITS = new Intl.NumberFormat("ru");

/** Why the times are this PC's, not the organization's; `null` when they are the organization's. */
type TimeNote = "localTime" | "localTimeZone" | null;

/** Why the devices are shown by the start of their ids; `null` when the list names them. */
type DevicesNote = "devicesAdminOnly" | "devicesUnavailable" | null;

export interface ShiftTotalsDialogProps {
  /** An active or a closed shift of the list. */
  shift: OfficeShift;
  onClose: () => void;
}

/**
 * A shift's figures (stage 2a spec §5.6, plan 2a2's `totals`): the shift is read
 * whenever the dialog opens (`GET /v1/office/shifts/{id}`), since the figures
 * change without a revision and the list behind it may be old. The last fact's
 * time is in the organization's time zone, or this PC's while the profile does
 * not load or names a zone this PC lacks, and says so; the zone is fixed when
 * the figures first show. The devices are named from the administrator's list
 * of devices; a technologist, an id that list lacks, or a list that did not
 * load shows the start of the id. The full card of a shift is stage 4.
 */
export function ShiftTotalsDialog({ shift, onClose }: ShiftTotalsDialogProps) {
  const { t } = useTranslation();
  const detail = useOfficeQuery(officeKeys.shift(shift.id), (api, token) =>
    api.getShift(token, shift.id),
  );

  const body = () => {
    if (detail.isPending) return <PageLoading />;
    if (detail.isError) {
      return <LoadError error={detail.error} onRetry={() => void detail.refetch()} />;
    }
    return <ShiftTotalsBody shift={detail.data} />;
  };

  return (
    <Modal
      open
      title={t("office.shifts.totals.title", { number: shift.number })}
      onClose={onClose}
      closeLabel={t("office.common.close")}
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t("office.common.close")}
        </Button>
      }
    >
      {body()}
    </Modal>
  );
}

/**
 * The figures of a shift already read, with the devices' names and the time
 * zone: what «Итоги» of the dialog and of the shift's drawer show.
 */
export function ShiftTotalsBody({ shift }: { shift: OfficeShift }) {
  const isAdmin = useOfficeSession().user.role === "admin";
  const org = useOfficeQuery(officeKeys.org, (api, token) => api.getOrg(token));
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    enabled: isAdmin,
  });
  if (org.isPending || (isAdmin && devices.isPending)) return <PageLoading />;
  const zone = org.isSuccess && isKnownTimeZone(org.data.timeZone) ? org.data.timeZone : null;
  return (
    <ShiftFigures
      shift={shift}
      zone={zone}
      timeNote={zone !== null ? null : org.isSuccess ? "localTimeZone" : "localTime"}
      devices={isAdmin ? devices.data : undefined}
      devicesNote={!isAdmin ? "devicesAdminOnly" : devices.isError ? "devicesUnavailable" : null}
    />
  );
}

/**
 * How the dialog names a device: its name, marked when revoked; the start of
 * its id when the list lacks it or was not read.
 */
function deviceLabel(id: string, devices: readonly DeviceRecord[] | undefined, t: TFunction) {
  const device = devices?.find((each) => each.id === id);
  if (device === undefined) return t("office.shifts.totals.unknownDevice", { id: id.slice(0, 8) });
  return device.revokedAt === null
    ? device.name
    : t("office.shifts.totals.revokedDevice", { name: device.name });
}

/**
 * «По устройствам» (plan 2b, spec §7): each device's part of the shift's totals, in the order of
 * the participants. A device is named by the host's own record of the participant (so a technologist
 * sees names), else as `deviceLabel` names it. A validation shift puts its codes in no box.
 */
function DeviceBreakdown({
  shift,
  devices,
}: {
  shift: OfficeShift;
  devices: readonly DeviceRecord[] | undefined;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const named = (id: string) =>
    shift.participants?.find((each) => each.deviceId === id)?.deviceName ??
    deviceLabel(id, devices, t);
  const value = (part: DeviceTotals) =>
    shift.mode === "validation"
      ? t("office.shifts.totals.byDeviceUnits", { units: UNITS.format(part.accepted) })
      : t("office.shifts.totals.byDeviceValue", {
          units: UNITS.format(part.accepted),
          boxes: UNITS.format(part.boxesClosed),
          pallets: UNITS.format(part.pallets),
        });
  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId} className="shift-breakdown__title">
        {t("office.shifts.totals.byDevice")}
      </h3>
      <DefinitionGrid
        items={(shift.byDevice ?? []).map((part) => ({
          id: part.deviceId,
          term: named(part.deviceId),
          description: value(part),
          mono: true,
        }))}
      />
    </section>
  );
}

interface ShiftFiguresProps {
  shift: OfficeShift;
  zone: string | null;
  timeNote: TimeNote;
  devices: readonly DeviceRecord[] | undefined;
  devicesNote: DevicesNote;
}

function ShiftFigures({
  shift,
  zone: zoneAtOpen,
  timeNote: timeNoteAtOpen,
  devices,
  devicesNote,
}: ShiftFiguresProps) {
  const { t } = useTranslation();
  // The zone the time is written in and the note about it are fixed when the figures first
  // show: the profile read again later (failing, or arriving after a failure) must not move
  // the time, or put a note under it, while the dialog stays open.
  const [{ zone, timeNote }] = useState(() => ({ zone: zoneAtOpen, timeNote: timeNoteAtOpen }));
  const time = new Intl.DateTimeFormat("ru", {
    dateStyle: "short",
    timeStyle: "short",
    ...(zone === null ? {} : { timeZone: zone }),
  });
  const { plannedQty, totals } = shift;
  return (
    <>
      <DefinitionGrid
        items={[
          {
            id: "plan",
            term: t("office.shifts.totals.plan"),
            description: plannedQty === null ? t("office.common.none") : UNITS.format(plannedQty),
            mono: true,
          },
          {
            id: "accepted",
            term: t("office.shifts.totals.accepted"),
            description: UNITS.format(totals.acceptedUnits),
            mono: true,
          },
          // A validation shift puts its codes in no box (plan РЕЖ, Р11): no box figure is its.
          ...(shift.mode === "validation"
            ? []
            : [
                {
                  id: "inClosedBoxes",
                  term: t("office.shifts.totals.inClosedBoxes"),
                  description: UNITS.format(totals.unitsInClosedBoxes),
                  mono: true,
                },
                {
                  id: "closedBoxes",
                  term: t("office.shifts.totals.closedBoxes"),
                  description: UNITS.format(totals.closedBoxes),
                  mono: true,
                },
                {
                  id: "openBoxes",
                  term: t("office.shifts.totals.openBoxes"),
                  description: UNITS.format(totals.openBoxes),
                  mono: true,
                },
              ]),
          {
            id: "lastFact",
            term: t("office.shifts.totals.lastFact"),
            description:
              totals.lastFactAt === null
                ? t("office.shifts.totals.noFacts")
                : time.format(new Date(totals.lastFactAt)),
          },
          {
            id: "devices",
            term: t("office.shifts.totals.devices"),
            description:
              totals.deviceIds.length === 0 ? (
                t("office.shifts.totals.noDevices")
              ) : (
                <span className="shift-cell">
                  {totals.deviceIds.map((id) => (
                    <span key={id}>{deviceLabel(id, devices, t)}</span>
                  ))}
                </span>
              ),
          },
        ]}
      />
      {timeNote !== null && totals.lastFactAt !== null && (
        <p className="office-note">{t(`office.shifts.totals.${timeNote}`)}</p>
      )}
      {devicesNote !== null && totals.deviceIds.length > 0 && (
        <p className="office-note">{t(`office.shifts.totals.${devicesNote}`)}</p>
      )}
      {shift.byDevice !== undefined && shift.byDevice.length > 1 && (
        <DeviceBreakdown shift={shift} devices={devices} />
      )}
    </>
  );
}
