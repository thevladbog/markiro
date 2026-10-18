import type { OfficeRole } from "../host/protocol.js";
import { isSettingsItem, OFFICE_NAV, type OfficeNavItem } from "./nav.js";

/** A group of menu entries under one name. */
export interface NavGroup {
  sectionKey: string;
  items: OfficeNavItem[];
  /** Whether the group belongs to the settings block (after the rule). */
  settings: boolean;
  /** The one hairline rule that sets the settings block apart stands above its first group. */
  ruleBefore: boolean;
  /** «Обзор» stands alone, without a name above it. */
  showLabel: boolean;
}

const UNNAMED_SECTION = "office.nav.sections.office";

/**
 * The menu's groups for a role: the entries the role may open, in the order of `OFFICE_NAV`,
 * grouped by consecutive section; a group with nothing for the role is not there.
 */
export function navGroups(role: OfficeRole): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of OFFICE_NAV) {
    if (!item.roles.includes(role)) continue;
    const last = groups[groups.length - 1];
    if (last !== undefined && last.sectionKey === item.sectionKey) {
      last.items.push(item);
      continue;
    }
    groups.push({
      sectionKey: item.sectionKey,
      items: [item],
      settings: isSettingsItem(item),
      ruleBefore: false,
      showLabel: item.sectionKey !== UNNAMED_SECTION,
    });
  }
  const firstSettings = groups.find((group) => group.settings);
  if (firstSettings !== undefined) firstSettings.ruleBefore = true;
  return groups;
}

/**
 * The two crumbs of a page: its menu group and its menu entry. A page below an entry (a template's
 * editor, a box card) takes the entry it hangs under; `/` matches only `/`. A path outside the
 * menu has none.
 */
export function crumbsFor(pathname: string): { sectionKey: string; labelKey: string } | null {
  pathname = menuPathFor(pathname);
  let best: OfficeNavItem | null = null;
  for (const item of OFFICE_NAV) {
    const matches =
      item.to === "/"
        ? pathname === "/"
        : pathname === item.to || pathname.startsWith(`${item.to}/`);
    if (matches && (best === null || item.to.length > best.to.length)) best = item;
  }
  return best === null ? null : { sectionKey: best.sectionKey, labelKey: best.labelKey };
}

/** Imported cards belong to Production / Shifts throughout menu and breadcrumb navigation. */
export function menuPathFor(pathname: string): string {
  return /^\/cloud-(shifts|boxes|pallets)(?:\/|$)/.test(pathname) ? "/shifts" : pathname;
}

export interface OfficeCrumb {
  labelKey: string;
  to?: string;
}

/** Parent links use actual routes; the current card never needs fabricated source metadata. */
export function crumbTrail(pathname: string, search = ""): OfficeCrumb[] {
  if (/^\/cloud-(shifts|boxes|pallets)(?:\/|$)/.test(pathname)) {
    const parent = [{ labelKey: "office.nav.shifts", to: "/shifts" }];
    if (pathname === "/cloud-shifts") return [...parent, { labelKey: "office.cloudShifts.cloud" }];
    const card = pathname.startsWith("/cloud-boxes/")
      ? "box"
      : pathname.startsWith("/cloud-pallets/")
        ? "pallet"
        : "shift";
    return [
      ...parent,
      { labelKey: "office.cloudShifts.cloud", to: "/cloud-shifts" },
      { labelKey: `office.header.cards.${card}` },
    ];
  }
  if (pathname === "/shifts" && new URLSearchParams(search).has("shift")) {
    return [
      { labelKey: "office.nav.shifts", to: "/shifts" },
      { labelKey: "office.header.cards.shift" },
    ];
  }
  if (/^\/codes\/(?:box|pallet)\//.test(pathname)) {
    const box = pathname.startsWith("/codes/box/");
    return [
      { labelKey: "office.nav.codeSearch", to: "/codes" },
      {
        labelKey: `office.registry.${box ? "boxes" : "pallets"}`,
        to: `/codes/${box ? "boxes" : "pallets"}`,
      },
      { labelKey: `office.header.cards.${box ? "box" : "pallet"}` },
    ];
  }
  const page = crumbsFor(pathname);
  return page === null ? [] : [{ labelKey: page.labelKey }];
}
