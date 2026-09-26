import type { OfficeRole } from "../host/protocol.js";

export interface OfficeNavItem {
  to: string;
  labelKey: string;
  sectionKey: string;
  roles: readonly OfficeRole[];
}

/** Office sections by role (spec §4.8); plan 1b3 adds the organization, SSCC and users. */
export const OFFICE_NAV: readonly OfficeNavItem[] = [
  {
    to: "/",
    labelKey: "office.nav.overview",
    sectionKey: "office.nav.sections.office",
    roles: ["admin", "technologist"],
  },
];
