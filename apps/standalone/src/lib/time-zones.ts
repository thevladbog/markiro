import type { ComboboxOption } from "@markiro/ui";

/** The default for a new site. */
export const DEFAULT_TIME_ZONE = "Europe/Moscow";

/** IANA zones this runtime knows, the default first, as time-zone picker options. */
export const TIME_ZONE_OPTIONS: readonly ComboboxOption[] = [
  ...new Set([DEFAULT_TIME_ZONE, ...Intl.supportedValuesOf("timeZone")]),
].map((zone) => ({ value: zone, label: zone.replaceAll("_", " "), keywords: [zone] }));
