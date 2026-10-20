import type { TagPhase } from "@markiro/ui";

import type { DeviceVersionState, OfficeUpdateStatus } from "../../host/distribution.js";

/** A device's state as a tag (the word goes beside it: never colour alone). */
export const DEVICE_STATE_PHASE: Readonly<Record<DeviceVersionState, TagPhase>> = {
  compatible: "done",
  incompatible: "failed",
  host_older: "attention",
  unknown: "none",
};

export interface UpdateSummary {
  hostVersion: string;
  total: number;
  compatible: number;
  incompatible: number;
  hostOlder: number;
  unknown: number;
}

/** «Хост: 0.3.0. Совместимы 3 из 5 …» (spec §10.11.7) as numbers: protocol, not app versions. */
export function summarize(status: OfficeUpdateStatus): UpdateSummary {
  const count = (state: DeviceVersionState) =>
    status.devices.filter((device) => device.state === state).length;
  return {
    hostVersion: status.hostVersion,
    total: status.devices.length,
    compatible: count("compatible"),
    incompatible: count("incompatible"),
    hostOlder: count("host_older"),
    unknown: count("unknown"),
  };
}

const PACKAGE_STATES = ["ok", "missing", "mismatch", "invalid", "verifying"] as const;

/** The i18n key's last part of the host's package state; a newer host's word is `unknown`. */
export function packageStateKey(state: string): (typeof PACKAGE_STATES)[number] | "unknown" {
  return PACKAGE_STATES.find((known) => known === state) ?? "unknown";
}
