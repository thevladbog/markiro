import type { HostUpdateOffer } from "./host-offer.js";

export interface UpdateEntryInput {
  offer: HostUpdateOffer;
  /** The link to the host answers (online), or the host answers and refuses this app. */
  reachable: boolean;
  /** A manual check is running. */
  checking: boolean;
  /** A manual check has finished at least once. */
  checked: boolean;
  /** A shift is in progress on this station: an update restarts the app, never now. */
  inShift: boolean;
}

/** What the station's update entry says (the version block and the sign-in chip). */
export type UpdateEntryState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "unreachable" }
  | { kind: "host_older" }
  | { kind: "intermediate"; min: string }
  | { kind: "verifying" }
  | { kind: "unreadable" }
  | { kind: "no_package" }
  | {
      kind: "available";
      version: string;
      notes: readonly string[];
      required: boolean;
      /** False during a shift: the words are shown, the button is not. */
      canInstall: boolean;
    };

export function updateEntryState(input: UpdateEntryInput): UpdateEntryState {
  const { offer } = input;
  if (input.checking) return { kind: "checking" };
  if (!input.reachable) return { kind: "unreachable" };
  switch (offer.kind) {
    case "available":
      return {
        kind: "available",
        version: offer.manifest.version,
        notes: offer.manifest.notes,
        required: offer.required,
        canInstall: !input.inShift,
      };
    case "host_older":
      return { kind: "host_older" };
    case "needs_intermediate":
      return { kind: "intermediate", min: offer.minUpgradeFrom };
    case "unavailable":
      if (offer.reason === "verifying") return { kind: "verifying" };
      return { kind: offer.reason === "unread" ? "unreadable" : "no_package" };
    case "none":
      return { kind: input.checked ? "latest" : "idle" };
  }
}
