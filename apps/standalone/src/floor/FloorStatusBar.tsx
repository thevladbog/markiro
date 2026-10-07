import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { HostStatusLine } from "../app/HostStatusLine.js";
import type { SyncState } from "../app/shell.js";
import type { HostStatus } from "../host/protocol.js";
import type { LocalExecutor } from "../local/executor.js";
import type { Pairing } from "../local/reference-sync.js";
import { readFloorPlace, type FloorPlace } from "./floor-status.js";
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
}

/**
 * The floor's status bar (stage 1 spec §5.6, plan 1f2), after the cloud
 * station's `StatusBar` (`apps/station/src/ui/StatusBar.tsx`): the
 * organization and the line from the local copies, the operator, and the
 * link to the host with the health of the copies (`HostStatusLine`). It sits
 * above the sign-in screen and the stub alike, as a labelled region (the app's
 * `main` holds it, so a `header` would not be a landmark), and holds nothing
 * to press.
 * The device's own name is not here: the shell does not keep it
 * (`DeviceStatus` has none). A failed read of the copies leaves the names
 * out; the floor works on.
 */
export function FloorStatusBar({
  local,
  pairing,
  lineId,
  operator,
  link,
  sync,
}: FloorStatusBarProps) {
  const { t } = useTranslation();
  const [place, setPlace] = useState<FloorPlace>({ organization: null, line: null });
  const { hostId, deviceId } = pairing;

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
      </dl>
      <HostStatusLine status={link} sync={sync} />
    </section>
  );
}
