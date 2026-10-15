import { useEffect, useState } from "react";

import type { HostApi } from "../host/api.js";
import { compareAppVersions, type DeviceUpdateOffer } from "../host/distribution.js";
import type { HostStatus } from "../host/protocol.js";
import { hostUpdateOffer, type HostOfferInput, type HostUpdateOffer } from "./host-offer.js";
import { UpdateError, type UpdatesApi } from "./updates-api.js";

interface OfferRead {
  hostVersion: string;
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
  // The read is kept per host version and read again each time the link comes
  // online or the host refuses this app, never on a flap to «away»: the offer
  // then stays what it was (the dialog may be mid-flow). A failed read never
  // replaces a good one of the same host version.
  const moment = link?.state === "online" ? "online" : appTooOld ? "too_old" : "away";
  const fetchKey = newer && moment !== "away" ? `${hostVersion}:${moment}` : null;
  const [read, setRead] = useState<OfferRead | null>(null);
  useEffect(() => {
    if (fetchKey === null || hostVersion === null) return;
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
      if (!alive) return;
      setRead((previous) =>
        offer === null && previous !== null && previous.hostVersion === hostVersion
          ? previous
          : { hostVersion, offer, manifest },
      );
    })();
    return () => {
      alive = false;
    };
  }, [fetchKey, hostVersion, host, updates]);
  const current = read !== null && read.hostVersion === hostVersion ? read : null;
  return hostUpdateOffer({
    appVersion,
    hostVersion,
    offer: current?.offer ?? null,
    manifest: current?.manifest ?? null,
    appTooOld,
  });
}
