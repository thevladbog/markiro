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
  {
    to: "/counterparties",
    labelKey: "office.nav.counterparties",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
  {
    to: "/lines",
    labelKey: "office.nav.lines",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/shifts",
    labelKey: "office.nav.shifts",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/operators",
    labelKey: "office.nav.operators",
    sectionKey: "office.nav.sections.production",
    roles: ["admin"],
  },
  {
    to: "/devices",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
    roles: ["admin"],
  },
  {
    to: "/products",
    labelKey: "office.nav.products",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/templates",
    labelKey: "office.nav.templates",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/template-defaults",
    labelKey: "office.nav.templateDefaults",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.access",
    roles: ["admin"],
  },
  {
    to: "/backups",
    labelKey: "office.nav.backups",
    sectionKey: "office.nav.sections.service",
    roles: ["admin", "technologist"],
  },
  {
    to: "/import",
    labelKey: "office.nav.cloudImport",
    sectionKey: "office.nav.sections.service",
    roles: ["admin"],
  },
];
