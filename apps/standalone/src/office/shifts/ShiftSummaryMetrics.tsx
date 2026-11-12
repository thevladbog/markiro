import { useTranslation } from "react-i18next";
import { StatusChip, UiSymbol } from "@markiro/ui";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { useOfficeSession } from "../office-session.js";
import { deviceLabel } from "./shift-device-label.js";
import type { OfficeShift } from "../../host/protocol.js";

const units = new Intl.NumberFormat("ru");

/** Only real host counts may complete a check; missing participants remain unknown. */
export function ShiftSummaryMetrics({ shift }: { shift: OfficeShift }) {
  const { t } = useTranslation();
  const { totals, plannedQty } = shift;
  const setAssembly = shift.setItems !== undefined;
  const tracksPackaging = shift.mode !== "validation" && !setAssembly;
  const percent =
    plannedQty !== null && plannedQty > 0
      ? Math.round((totals.acceptedUnits / plannedQty) * 100)
      : null;
  const packaging =
    totals.acceptedUnits > 0 &&
    totals.unitsInClosedBoxes === totals.acceptedUnits &&
    totals.openBoxes === 0;
  const participants = shift.participants ?? [];
  const closed = participants.filter((part) => part.state === "closed").length;
  const allClosed = participants.length > 0 && closed === participants.length;
  return (
    <section className="shift-metrics" aria-label={t("office.shiftCard.dashboard.title")}>
      <div className="shift-metrics__numbers">
        <div className="shift-metrics__primary">
          <span className="shift-metrics__label">
            {t(
              setAssembly ? "office.shiftCard.sets.assembled" : "office.shiftCard.dashboard.output",
            )}
          </span>
          <strong className="shift-metrics__value">
            {units.format(totals.acceptedUnits)}
            {plannedQty === null ? null : <span> / {units.format(plannedQty)}</span>}
          </strong>
          <span className="shift-metrics__hint">
            {percent === null
              ? plannedQty === null
                ? t("office.shiftCard.dashboard.noPlan")
                : t("office.shiftCard.dashboard.zeroPlan")
              : t("office.shiftCard.dashboard.percent", { percent })}
          </span>
        </div>
        {tracksPackaging && (
          <>
            <div>
              <span className="shift-metrics__label">{t("office.shifts.totals.closedBoxes")}</span>
              <strong className="shift-metrics__secondary">
                {units.format(totals.closedBoxes)}
              </strong>
              <span className="shift-metrics__hint">
                {t("office.shiftCard.dashboard.capacity", { count: shift.boxCapacity })}
              </span>
            </div>
            {shift.palletsEnabled && (
              <div>
                <span className="shift-metrics__label">{t("office.shiftCard.pallets.title")}</span>
                <strong className="shift-metrics__secondary">
                  {units.format(totals.closedPallets + totals.openPallets)}
                </strong>
                <span className="shift-metrics__hint">
                  {t("office.shiftCard.dashboard.pallets", {
                    closed: totals.closedPallets,
                    open: totals.openPallets,
                  })}
                </span>
              </div>
            )}
          </>
        )}
      </div>
      {percent !== null && (
        <div
          className="shift-metrics__progress"
          role="progressbar"
          aria-label={t("office.shiftCard.dashboard.progress")}
          aria-valuenow={Math.min(100, percent)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={t("office.shiftCard.dashboard.percent", { percent })}
        >
          <span style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
      {(tracksPackaging || participants.length > 0) && (
        <div className="shift-metrics__completion">
          <h3>{t("office.shiftCard.dashboard.completion")}</h3>
          <div className="shift-metrics__checks">
            {tracksPackaging && (
              <Check
                ok={packaging}
                title={t(
                  totals.acceptedUnits === 0
                    ? "office.shiftCard.dashboard.noCodes"
                    : packaging
                      ? "office.shiftCard.dashboard.packed"
                      : "office.shiftCard.dashboard.unpacked",
                )}
                detail={t("office.shiftCard.dashboard.packCounts", {
                  packed: units.format(totals.unitsInClosedBoxes),
                  accepted: units.format(totals.acceptedUnits),
                  open: units.format(totals.openBoxes),
                })}
              />
            )}
            {participants.length > 0 && (
              <Check
                ok={allClosed}
                title={t(
                  allClosed
                    ? "office.shiftCard.dashboard.partsClosed"
                    : "office.shiftCard.dashboard.partsOpen",
                )}
                detail={t("office.shiftCard.dashboard.parts", {
                  closed,
                  total: participants.length,
                })}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Check({ ok, title, detail }: { ok: boolean; title: string; detail: string }) {
  return (
    <div className="shift-metrics__check" data-complete={ok}>
      <span className="shift-metrics__check-icon">
        <UiSymbol name={ok ? "check" : "warning"} size={18} />
      </span>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    </div>
  );
}

/** Device proportions are shown only when the breakdown agrees with the total. */
export function ShiftDeviceContributions({ shift }: { shift: OfficeShift }) {
  const { t } = useTranslation();
  const isAdmin = useOfficeSession().user.role === "admin";
  const devices = useOfficeQuery(officeKeys.devices, (api, token) => api.listDevices(token), {
    enabled: isAdmin,
  });
  const parts = shift.byDevice ?? [];
  if (parts.length < 2) return null;
  const tracksPackaging = shift.mode !== "validation" && shift.setItems === undefined;
  const reconciled =
    shift.totals.acceptedUnits > 0 &&
    parts.reduce((sum, part) => sum + part.accepted, 0) === shift.totals.acceptedUnits;
  return (
    <section className="shift-contributions">
      <h3>{t("office.shiftCard.dashboard.contributions")}</h3>
      <div
        className="shift-contributions__scroll"
        role="region"
        tabIndex={0}
        aria-label={t("office.shiftCard.dashboard.contributions")}
      >
        <table>
          <thead>
            <tr>
              <th>{t("office.shiftCard.scans.station")}</th>
              <th>{t("office.shifts.totals.accepted")}</th>
              {tracksPackaging && (
                <>
                  <th>{t("office.shiftCard.tabs.boxes")}</th>
                  {shift.palletsEnabled && <th>{t("office.shiftCard.tabs.pallets")}</th>}
                </>
              )}
              <th>{t("office.shiftCard.dashboard.part")}</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((part) => {
              const participant = shift.participants?.find((p) => p.deviceId === part.deviceId);
              return (
                <tr key={part.deviceId}>
                  <td>
                    <strong>
                      {participant?.deviceName || deviceLabel(part.deviceId, devices.data, t)}
                    </strong>
                    {reconciled && (
                      <span className="shift-contributions__share">
                        <span className="shift-contributions__track">
                          <span
                            style={{
                              width: `${(part.accepted / shift.totals.acceptedUnits) * 100}%`,
                            }}
                          />
                        </span>
                        {Math.round((part.accepted / shift.totals.acceptedUnits) * 100)}%
                      </span>
                    )}
                  </td>
                  <td>{units.format(part.accepted)}</td>
                  {tracksPackaging && (
                    <>
                      <td>{units.format(part.boxesClosed)}</td>
                      {shift.palletsEnabled && <td>{units.format(part.pallets)}</td>}
                    </>
                  )}
                  <td>
                    {participant ? (
                      <StatusChip
                        phase={
                          participant.state === "closed"
                            ? "done"
                            : participant.state === "left"
                              ? "attention"
                              : "active"
                        }
                        label={t(`office.shiftCard.dashboard.partStates.${participant.state}`)}
                      />
                    ) : (
                      t("office.common.none")
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
