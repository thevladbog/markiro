import type { OfficeRole } from "../host/protocol.js";

export interface OfficeNavItem {
  to: string;
  labelKey: string;
  sectionKey: string;
  roles: readonly OfficeRole[];
}

/** Office sections by role (spec §4.8); paths match `officeRoutes`. */
export const OFFICE_NAV: readonly OfficeNavItem[] = [
  {
    to: "/",
    labelKey: "office.nav.overview",
    sectionKey: "office.nav.sections.office",
    roles: ["admin", "technologist"],
  },
  {
    to: "/org",
    labelKey: "office.nav.orgProfile",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
  {
    to: "/sscc",
    labelKey: "office.nav.sscc",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
];
