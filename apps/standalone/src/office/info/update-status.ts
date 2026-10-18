import type { TagPhase } from "@markiro/ui";

import type { DeviceVersionState, OfficeUpdateStatus } from "../../host/distribution.js";

/** A device's state as a tag (the word goes beside it: never colour alone). */
export const DEVICE_STATE_PHASE: Readonly<Record<DeviceVersionState, TagPhase>> = {
  current: "done",
  behind: "attention",
  incompatible: "failed",
  newer: "attention",
  unknown: "none",
};

export interface UpdateSummary {
  hostVersion: string;
  total: number;
  current: number;
  behind: number;
  incompatible: number;
  newer: number;
  unknown: number;
}

/** «Хост: 0.3.0. Актуальны 3 из 5 …» (spec §10.11.7) as numbers. */
export function summarize(status: OfficeUpdateStatus): UpdateSummary {
  const count = (state: DeviceVersionState) =>
    status.devices.filter((device) => device.state === state).length;
  return {
    hostVersion: status.hostVersion,
    total: status.devices.length,
    current: count("current"),
    behind: count("behind"),
    incompatible: count("incompatible"),
    newer: count("newer"),
    unknown: count("unknown"),
  };
}

const PACKAGE_STATES = ["ok", "missing", "mismatch", "invalid", "verifying"] as const;

/** The i18n key's last part of the host's package state; a newer host's word is `unknown`. */
export function packageStateKey(state: string): (typeof PACKAGE_STATES)[number] | "unknown" {
  return PACKAGE_STATES.find((known) => known === state) ?? "unknown";
}
