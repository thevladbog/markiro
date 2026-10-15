import { useEffect, useState } from "react";

import type { DeviceInfo, DeviceLicense } from "../host/protocol.js";

export interface StationLicenseOptions {
  /** The station whose host is asked; `null` asks nothing (unpaired, an office PC, a stopped link). */
  pairing: { hostId: string; deviceId: string } | null;
  /** `HostApi.getDevice`. */
  read: () => Promise<DeviceInfo>;
  /** `ShellState.hostRevision`: a phase of the license changes with a revision (spec §8.2), so each one reads again. */
  revision: number | null;
  /** The link to the host is online: going online reads again, and nothing is asked while it is not. */
  online: boolean;
}

/**
 * The site's license as the station last heard it (`GET /v1/device`, field
 * `license`; plan ЛЦ-3): read when the link comes online and after every
 * revision, kept in memory for this pairing only (spec §9.6: without the host
 * the last known state; after a restart the first answer, plan ЛЦ-3 Д4). A
 * failed read keeps what was known: opening a shift needs the host anyway,
 * and it then answers for itself. A host before plan ЛЦ-2 sends no field,
 * which is `null`: silence. The answer of a read the next one replaced is
 * dropped.
 */
export function useStationLicense({
  pairing,
  read,
  revision,
  online,
}: StationLicenseOptions): DeviceLicense | null {
  const key = pairing === null ? null : `${pairing.hostId}:${pairing.deviceId}`;
  const [known, setKnown] = useState<{ key: string; license: DeviceLicense | null } | null>(null);
  useEffect(() => {
    if (key === null || !online) return;
    let cancelled = false;
    read().then(
      (record) => {
        if (!cancelled) setKnown({ key, license: record.license ?? null });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [key, read, revision, online]);
  return known !== null && known.key === key ? known.license : null;
}
