import { useEffect, useState } from "react";

import type { HostApi } from "../host/api.js";
import { compareAppVersions, type DeviceUpdateOffer } from "../host/distribution.js";
import type { HostStatus } from "../host/protocol.js";
import { hostUpdateOffer, type HostOfferInput, type HostUpdateOffer } from "./host-offer.js";
import { UpdateError, type UpdatesApi } from "./updates-api.js";

interface OfferRead {
  key: string;
  offer: DeviceUpdateOffer | null;
  manifest: HostOfferInput["manifest"];
}

/**
 * The update the host offers this PC, for the office's banner, the
 * station's line and the version screen. The offer is read (with the shell
 * checking its manifest) only while the host is newer than this PC, again
 * when the host's version changes and each time the link comes online or
 * the host refuses this app; never on a timer.
 */
export function useHostUpdateOffer({
  link,
  paired,
  host,
  updates,
}: {
  link: HostStatus | null;
  paired: boolean;
  host: Pick<HostApi, "getDeviceUpdate">;
  updates: Pick<UpdatesApi, "appVersion" | "checkManifest">;
}): HostUpdateOffer {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    updates.appVersion().then(
      (version) => {
        if (alive) setAppVersion(version);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [updates]);
  const hostVersion = link?.hostVersion ?? null;
  const appTooOld = link?.lastError === "app_too_old";
  const newer =
    paired &&
    appVersion !== null &&
    hostVersion !== null &&
    compareAppVersions(hostVersion, appVersion) === 1;
  const moment = link?.state === "online" ? "online" : appTooOld ? "too_old" : "away";
  const key = newer ? `${hostVersion}:${moment}` : null;
  const [read, setRead] = useState<OfferRead | null>(null);
  useEffect(() => {
    if (key === null) return;
    let alive = true;
    void (async () => {
      let offer: DeviceUpdateOffer | null = null;
      let manifest: OfferRead["manifest"] = null;
      try {
        offer = await host.getDeviceUpdate();
        const text = offer.package.state === "ok" ? offer.package.manifest : undefined;
        if (text !== undefined) {
          manifest = await updates.checkManifest(text).catch((error: unknown) => ({
            refused: error instanceof UpdateError ? error.code : "refused",
          }));
        }
      } catch {
        // The offer was not read: `offer` stays `null` and the rule says «unread».
      }
      if (alive) setRead({ key, offer, manifest });
    })();
    return () => {
      alive = false;
    };
  }, [key, host, updates]);
  const current = read !== null && read.key === key ? read : null;
  return hostUpdateOffer({
    appVersion,
    hostVersion,
    offer: current?.offer ?? null,
    manifest: current?.manifest ?? null,
    appTooOld,
  });
}
