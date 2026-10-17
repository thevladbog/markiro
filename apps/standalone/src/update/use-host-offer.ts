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
 * How long to wait before asking again while the host still says
 * `verifying` (it hashes its packages in the background after a start): the
 * tries are bounded, about two minutes in all.
 */
export const VERIFYING_RETRY_MS: readonly number[] = [
  3000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 30000, 30000,
];

/**
 * The update the host offers this PC, for the office's banner, the
 * station's line and the version screen. The offer is read (with the shell
 * checking its manifest) only while the host is newer than this PC, again
 * when the host's version changes and each time the link comes online or
 * the host refuses this app; never on a timer, except a bounded retry while
 * the host itself says its package is `verifying`.
 */
export function useHostUpdateOffer(options: HostUpdateOfferOptions): HostUpdateOffer {
  return useHostUpdateCheck(options).offer;
}

interface HostUpdateOfferOptions {
  link: HostStatus | null;
  paired: boolean;
  host: Pick<HostApi, "getDeviceUpdate">;
  updates: Pick<UpdatesApi, "appVersion" | "checkManifest">;
  retryDelaysMs?: readonly number[];
}

export interface HostUpdateCheck {
  offer: HostUpdateOffer;
  /** This build's version, once the shell has said it. */
  appVersion: string | null;
  /** «Проверить обновление»: reads the host's offer again now (a person asked, not a timer). */
  check: () => void;
  checking: boolean;
  /** A manual check has finished at least once. */
  checked: boolean;
  /** The host answers (online), or answers and refuses this app. */
  reachable: boolean;
}

/**
 * `useHostUpdateOffer` plus the station's manual «Проверить обновление»: `check` reads the offer
 * again at once (the same read, the same rules), never on a timer.
 */
export function useHostUpdateCheck({
  link,
  paired,
  host,
  updates,
  retryDelaysMs = VERIFYING_RETRY_MS,
}: HostUpdateOfferOptions): HostUpdateCheck {
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
  // The tries made for this key; a new key starts again.
  const [tries, setTries] = useState<{ key: string | null; count: number }>({
    key: null,
    count: 0,
  });
  const attempt = tries.key === fetchKey ? tries.count : 0;
  // A manual check: `asked` counts the requests, `answered` the last one that finished.
  const [asked, setAsked] = useState(0);
  const [answered, setAnswered] = useState(0);
  useEffect(() => {
    if (fetchKey === null || hostVersion === null) {
      // Nothing to read (the host is not newer, or cannot be reached): the check is done.
      setAnswered(asked);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      setAnswered(asked);
      setRead((previous) =>
        offer === null && previous !== null && previous.hostVersion === hostVersion
          ? previous
          : { hostVersion, offer, manifest },
      );
      const delay = retryDelaysMs[attempt];
      if (offer?.package.state === "verifying" && delay !== undefined) {
        timer = setTimeout(() => {
          setTries({ key: fetchKey, count: attempt + 1 });
        }, delay);
      }
    })();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [fetchKey, hostVersion, host, updates, attempt, retryDelaysMs, asked]);
  const current = read !== null && read.hostVersion === hostVersion ? read : null;
  return {
    offer: hostUpdateOffer({
      appVersion,
      hostVersion,
      offer: current?.offer ?? null,
      manifest: current?.manifest ?? null,
      appTooOld,
    }),
    appVersion,
    check: () => setAsked((count) => count + 1),
    checking: asked !== answered,
    checked: answered > 0,
    reachable: link?.state === "online" || appTooOld,
  };
}
