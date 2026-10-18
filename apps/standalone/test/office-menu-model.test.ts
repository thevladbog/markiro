import { describe, expect, it } from "vitest";

import { AUTO_COLLAPSE_BELOW, isMenuCollapsed } from "../src/office/menu-collapse.js";
import { crumbsFor, navGroups } from "../src/office/nav-groups.js";
import { OFFICE_NAV, isSettingsItem } from "../src/office/nav.js";

describe("the menu's collapse decision", () => {
  it("collapses on its own below 1366 px and stays open from 1366", () => {
    expect(AUTO_COLLAPSE_BELOW).toBe(1366);
    expect(isMenuCollapsed(1280, null)).toBe(true);
    expect(isMenuCollapsed(1365, null)).toBe(true);
    expect(isMenuCollapsed(1366, null)).toBe(false);
    expect(isMenuCollapsed(1440, null)).toBe(false);
  });

  it("lets the user's own choice win over the width", () => {
    expect(isMenuCollapsed(1280, false)).toBe(false);
    expect(isMenuCollapsed(1920, true)).toBe(true);
  });

  it("treats an unknown width as a wide window", () => {
    expect(isMenuCollapsed(0, null)).toBe(false);
  });
});

describe("the menu's groups", () => {
  const labels = (role: "admin" | "technologist") =>
    navGroups(role).map((group) => [group.sectionKey, group.items.map((item) => item.to)]);

  it("lists the groups in the design's order, the settings after a rule", () => {
    const groups = navGroups("admin");
    expect(groups.map((group) => group.sectionKey)).toEqual([
      "office.nav.sections.office",
      "office.nav.sections.production",
      "office.nav.sections.catalog",
      "office.nav.sections.organization",
      "office.nav.sections.service",
    ]);
    expect(groups.map((group) => group.settings)).toEqual([false, false, false, true, true]);
    // The rule stands once, above the first settings group.
    expect(groups.filter((group) => group.ruleBefore).map((group) => group.sectionKey)).toEqual([
      "office.nav.sections.organization",
    ]);
    // «Обзор» has no group name above it.
    expect(groups[0]?.showLabel).toBe(false);
    expect(groups.slice(1).every((group) => group.showLabel)).toBe(true);
  });

  it("has merged «Доступ» into «Организация», with «Пользователи» last", () => {
    const org = navGroups("admin").find(
      (group) => group.sectionKey === "office.nav.sections.organization",
    );
    expect(org?.items.map((item) => item.to)).toEqual([
      "/org",
      "/sscc",
      "/counterparties",
      "/users",
    ]);
    expect(OFFICE_NAV.some((item) => item.sectionKey === "office.nav.sections.access")).toBe(false);
  });

  it("keeps every route, and an administrator sees all 17", () => {
    expect(navGroups("admin").flatMap((group) => group.items.map((item) => item.to))).toEqual(
      OFFICE_NAV.map((item) => item.to),
    );
    expect(OFFICE_NAV).toHaveLength(17);
    expect(OFFICE_NAV.filter(isSettingsItem).map((item) => item.to)).toEqual([
      "/org",
      "/sscc",
      "/counterparties",
      "/users",
      "/backups",
      "/import",
      "/about",
    ]);
  });

  it("filters by role: a technologist has no operators, devices, users or cloud import", () => {
    const paths = labels("technologist").flatMap(([, items]) => items as string[]);
    for (const hidden of ["/operators", "/devices", "/users", "/import"]) {
      expect(paths).not.toContain(hidden);
    }
    expect(paths).toContain("/backups");
    expect(paths).toContain("/org");
  });

  it("never leaves an empty group behind", () => {
    for (const role of ["admin", "technologist"] as const) {
      expect(navGroups(role).every((group) => group.items.length > 0)).toBe(true);
    }
  });

  it("gives every entry an icon", () => {
    expect(OFFICE_NAV.every((item) => item.icon.length > 0)).toBe(true);
  });
});

describe("the breadcrumbs", () => {
  it("is the group and the page for a page of the menu", () => {
    expect(crumbsFor("/products")).toEqual({
      sectionKey: "office.nav.sections.catalog",
      labelKey: "office.nav.products",
    });
    expect(crumbsFor("/")).toEqual({
      sectionKey: "office.nav.sections.office",
      labelKey: "office.nav.overview",
    });
  });

  it("follows a page below a menu entry to that entry, not to «Обзор»", () => {
    expect(crumbsFor("/templates/new")?.labelKey).toBe("office.nav.templates");
    expect(crumbsFor("/codes/boxes/abc")?.labelKey).toBe("office.nav.codeSearch");
  });

  it("knows nothing about a path outside the menu", () => {
    expect(crumbsFor("/nowhere")).toBeNull();
  });
});
