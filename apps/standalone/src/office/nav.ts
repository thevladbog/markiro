import type { OfficeRole } from "../host/protocol.js";
import type { OfficeIconName } from "./OfficeIcon.js";

export interface OfficeNavItem {
  to: string;
  /** The entry's icon, drawn by `OfficeIcon`. */
  icon: OfficeIconName;
  labelKey: string;
  sectionKey: string;
  roles: readonly OfficeRole[];
}

/** Office sections by role (spec §4.8); paths match `officeRoutes`. */
export const OFFICE_NAV: readonly OfficeNavItem[] = [
  {
    to: "/",
    icon: "home",
    labelKey: "office.nav.overview",
    sectionKey: "office.nav.sections.office",
    roles: ["admin", "technologist"],
  },
  {
    to: "/lines",
    icon: "factory",
    labelKey: "office.nav.lines",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/shifts",
    icon: "calendarCheck",
    labelKey: "office.nav.shifts",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/conflicts",
    icon: "warning",
    labelKey: "office.nav.conflicts",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/disaggregation",
    icon: "split",
    labelKey: "office.nav.disaggregation",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/operators",
    icon: "badge",
    labelKey: "office.nav.operators",
    sectionKey: "office.nav.sections.production",
    roles: ["admin"],
  },
  {
    to: "/devices",
    icon: "monitor",
    labelKey: "office.nav.devices",
    sectionKey: "office.nav.sections.production",
    roles: ["admin"],
  },
  {
    to: "/codes",
    icon: "search",
    labelKey: "office.nav.codeSearch",
    sectionKey: "office.nav.sections.production",
    roles: ["admin", "technologist"],
  },
  {
    to: "/products",
    icon: "package",
    labelKey: "office.nav.products",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/templates",
    icon: "tag",
    labelKey: "office.nav.templates",
    sectionKey: "office.nav.sections.catalog",
    roles: ["admin", "technologist"],
  },
  {
    to: "/org",
    icon: "building",
    labelKey: "office.nav.orgProfile",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
  {
    to: "/sscc",
    icon: "barcode",
    labelKey: "office.nav.sscc",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
  {
    to: "/counterparties",
    icon: "handshake",
    labelKey: "office.nav.counterparties",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin", "technologist"],
  },
  {
    to: "/users",
    icon: "users",
    labelKey: "office.nav.users",
    sectionKey: "office.nav.sections.organization",
    roles: ["admin"],
  },
  {
    to: "/backups",
    icon: "database",
    labelKey: "office.nav.backups",
    sectionKey: "office.nav.sections.service",
    roles: ["admin", "technologist"],
  },
  {
    to: "/import",
    icon: "cloud",
    labelKey: "office.nav.cloudImport",
    sectionKey: "office.nav.sections.service",
    roles: ["admin"],
  },
  {
    to: "/about",
    icon: "info",
    labelKey: "office.nav.about",
    sectionKey: "office.nav.sections.service",
    roles: ["admin", "technologist"],
  },
];

/**
 * The sections of settings: the menu lists them last, apart from the operational ones by a rule
 * (one style for every entry; «Доступ» is part of «Организация» since the 2026-10 redesign).
 * Routes are the same.
 */
export const SETTINGS_SECTION_KEYS: ReadonlySet<string> = new Set([
  "office.nav.sections.organization",
  "office.nav.sections.service",
]);

/** Whether an item belongs to the settings block at the foot of the menu. */
export function isSettingsItem(item: OfficeNavItem): boolean {
  return SETTINGS_SECTION_KEYS.has(item.sectionKey);
}
