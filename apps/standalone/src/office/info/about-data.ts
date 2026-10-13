import { useQuery } from "@tanstack/react-query";

import { LOCAL_HOST_ADDRESS, type Hello } from "../../host/protocol.js";
import type { InstallRole } from "../../host/device.js";
import type { AboutApi, SystemInfo } from "./about-api.js";
import { useAbout } from "./about-context.js";

/** What «Информация» learned about this PC and its host; every part may be missing. */
export interface AboutData {
  appVersion: string | null;
  role: InstallRole | "unknown";
  system: SystemInfo | null;
  /** The host the office talks to: the pairing's, else the one on this computer. */
  hostAddress: string;
  hostId: string | null;
  /** The host's `hello`, or `null` when it did not answer. */
  hello: Hello | null;
}

/** Reads everything once. A part that fails is `null` (`"unknown"` for the role): the page shows what it has. */
export async function loadAboutData(api: AboutApi): Promise<AboutData> {
  const [appVersion, role, system, pairing] = await Promise.all([
    api.appVersion().catch(() => null),
    api.installRole().catch((): "unknown" => "unknown"),
    api.system().catch(() => null),
    api.pairing().catch(() => null),
  ]);
  const hostAddress = pairing?.hostAddress ?? LOCAL_HOST_ADDRESS;
  const hello = await api.hello(hostAddress).then(
    (observation) => observation.hello,
    () => null,
  );
  return {
    appVersion,
    role,
    system,
    hostAddress,
    hostId: pairing?.hostId ?? hello?.hostId ?? null,
    hello,
  };
}

export const ABOUT_KEY = ["office", "about"] as const;

/** `loadAboutData` as a query: read afresh whenever the page opens. */
export function useAboutData() {
  const api = useAbout();
  return useQuery({ queryKey: ABOUT_KEY, queryFn: () => loadAboutData(api) });
}
