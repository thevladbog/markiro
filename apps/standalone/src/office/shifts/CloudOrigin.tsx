import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { OfficeConflictScan } from "../../host/review.js";
import { CLOUD_HISTORY_DEVICE_ID } from "../../host/cloud-history-read.js";
import { officeKeys, useOfficeQuery } from "../office-query.js";
import { shiftCardPath } from "./shift-card.js";

/** Owner-only history can reference a shift/box outside the imported closure: never invent a native link. */
export function CloudOrigin({ scan }: { scan: OfficeConflictScan }) {
  const { t } = useTranslation();
  const cloud = scan.deviceId === CLOUD_HISTORY_DEVICE_ID;
  const shift = useOfficeQuery(
    officeKeys.cloudShift(scan.shiftId),
    (api, token) => api.getCloudShift(token, scan.shiftId),
    { enabled: cloud },
  );
  const box = useOfficeQuery(
    officeKeys.cloudBox(scan.boxId ?? ""),
    (api, token) => api.getCloudBox(token, scan.boxId ?? ""),
    { enabled: cloud && scan.boxId !== null },
  );
  const label = t("office.conflicts.scan.shift", { number: scan.shiftNumber });
  return (
    <>
      <span>
        {cloud ? (
          shift.isSuccess ? (
            <Link to={`/cloud-shifts/${scan.shiftId}`}>{label}</Link>
          ) : (
            label
          )
        ) : (
          <Link to={shiftCardPath(scan.shiftId)}>{label}</Link>
        )}
      </span>
      <span>{cloud ? t("office.cloudShifts.cloudOrigin") : scan.deviceName}</span>
      {cloud && scan.boxId !== null && (
        <span>
          {box.isSuccess ? (
            <Link to={`/cloud-boxes/${scan.boxId}`}>
              {scan.boxSscc ?? t("office.cloudShifts.noSscc")}
            </Link>
          ) : (
            t("office.cloudShifts.externalBox")
          )}
        </span>
      )}
    </>
  );
}
