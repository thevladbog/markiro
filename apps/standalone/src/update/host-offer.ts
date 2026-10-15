import { compareAppVersions, type DeviceUpdateOffer } from "../host/distribution.js";
import type { ManifestView } from "./updates-api.js";

/** What this PC's update from the host is (spec §10.11.5). */
export type HostUpdateOffer =
  /** The host is not newer, or one version is unknown. */
  | { kind: "none" }
  /** The host is older than this PC: update the host. Never a downgrade. */
  | { kind: "host_older"; hostVersion: string; appVersion: string }
  /** The host is newer but gives no package of its version; `reason` is its state or the refusal. */
  | { kind: "unavailable"; hostVersion: string; reason: string }
  /** This PC is below the package's `minUpgradeFrom`: an intermediate version from a file first. */
  | { kind: "needs_intermediate"; hostVersion: string; minUpgradeFrom: string }
  /** All four conditions hold; `required` while the host refuses this app (`app_too_old`). */
  | { kind: "available"; hostVersion: string; manifest: ManifestView; required: boolean };

export interface HostOfferInput {
  appVersion: string | null;
  /** `hello.version` as the link read it. */
  hostVersion: string | null;
  /** `GET /v1/device/update`, or `null` when it was not read. */
  offer: DeviceUpdateOffer | null;
  /** The shell's check of the offer's manifest: its view, or the code it refused with. */
  manifest: ManifestView | { refused: string } | null;
  appTooOld: boolean;
}

const NONE: HostUpdateOffer = { kind: "none" };

/**
 * «Доступно обновление» — when, at once: (1) the host is newer than this PC;
 * (2) it gives a package (`ok`) of exactly its version; (3) this PC is not
 * below the manifest's `minUpgradeFrom`; (4) the manifest's signature
 * checked out. A host older than this PC is said, never offered.
 */
export function hostUpdateOffer(input: HostOfferInput): HostUpdateOffer {
  const { appVersion, hostVersion, offer, manifest, appTooOld } = input;
  if (appVersion === null || hostVersion === null) return NONE;
  const order = compareAppVersions(hostVersion, appVersion);
  if (order === null || order === 0) return NONE;
  if (order < 0) return { kind: "host_older", hostVersion, appVersion };
  if (offer === null) return { kind: "unavailable", hostVersion, reason: "unread" };
  if (offer.package.state !== "ok") {
    return { kind: "unavailable", hostVersion, reason: offer.package.state };
  }
  const packaged = offer.package.version;
  if (packaged === undefined || compareAppVersions(packaged, hostVersion) !== 0) {
    return { kind: "unavailable", hostVersion, reason: "version_differs" };
  }
  if (manifest === null) return { kind: "unavailable", hostVersion, reason: "unread" };
  if ("refused" in manifest) return { kind: "unavailable", hostVersion, reason: manifest.refused };
  if (compareAppVersions(manifest.version, hostVersion) !== 0) {
    return { kind: "unavailable", hostVersion, reason: "version_differs" };
  }
  const floor = compareAppVersions(appVersion, manifest.minUpgradeFrom);
  if (floor === null || floor < 0) {
    return { kind: "needs_intermediate", hostVersion, minUpgradeFrom: manifest.minUpgradeFrom };
  }
  return { kind: "available", hostVersion, manifest, required: appTooOld };
}
