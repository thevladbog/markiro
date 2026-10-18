import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { hostDotTone, HostStatusDot } from "../src/app/HostStatusDot.js";
import type { SyncState } from "../src/app/shell.js";
import type { HostStatus } from "../src/host/protocol.js";
import { StatusDot } from "../src/lib/StatusDot.js";
import { isSettingsItem, OFFICE_NAV } from "../src/office/nav.js";
import { fakeOfficeSession, renderOffice, TECHNOLOGIST } from "./support/office.js";

const ONLINE: HostStatus = { state: "online", lastContactAt: 1_000, lastError: null, seq: 1 };
const sync = (overrides: Partial<SyncState> = {}): SyncState => ({
  kind: "done",
  synced: 1,
  failure: null,
  quarantined: 0,
  ...overrides,
});

describe("StatusDot", () => {
  it("is a picture with a name, never colour alone", () => {
    render(<StatusDot tone="warn" label="Подключение" />);
    const dot = screen.getByRole("img", { name: "Подключение" });
    expect(dot.className).toContain("status-dot--warn");
    expect(dot.getAttribute("title")).toBe("Подключение");
  });

  it("can sit inside a control that already carries the name", () => {
    const { container } = render(<StatusDot tone="ok" label="x" decorative />);
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the tone of the host link", () => {
  it("is green for a healthy link, amber while connecting or while the copies need care, red when silent", () => {
    expect(hostDotTone(ONLINE, sync())).toBe("ok");
    expect(hostDotTone(ONLINE, null)).toBe("ok");
    expect(hostDotTone({ ...ONLINE, state: "connecting" }, null)).toBe("warn");
    expect(hostDotTone(ONLINE, sync({ failure: "host" }))).toBe("warn");
    expect(hostDotTone(ONLINE, sync({ quarantined: 2 }))).toBe("warn");
    expect(hostDotTone({ ...ONLINE, state: "offline", lastError: "unreachable" }, null)).toBe(
      "error",
    );
    expect(hostDotTone(null, null)).toBe("neutral");
  });
});

describe("HostStatusDot", () => {
  it("names the state on the button and keeps the details until it is pressed", () => {
    render(<HostStatusDot status={ONLINE} sync={null} />);
    const button = screen.getByRole("button", { name: "Связь с хостом: На связи с хостом" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region")).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByRole("region", { name: "Связь с хостом: На связи с хостом" });
    expect(within(panel).getByText("На связи с хостом")).toBeTruthy();
  });

  it("says why the host is silent in the popover and closes on Escape, returning to the button", () => {
    render(
      <HostStatusDot
        status={{ state: "offline", lastContactAt: null, lastError: "unreachable", seq: 2 }}
        sync={null}
      />,
    );
    const button = screen.getByRole("button", { name: "Связь с хостом: Нет связи с хостом" });
    fireEvent.click(button);
    expect(screen.getByText("Хост не отвечает.")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a press outside", () => {
    render(
      <div>
        <HostStatusDot status={ONLINE} sync={null} />
        <p>вне</p>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Связь с хостом/ }));
    expect(screen.getByRole("region")).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("вне"));
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("says a failed sync in the popover and in the name", () => {
    render(<HostStatusDot status={ONLINE} sync={sync({ failure: "host" })} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Связь с хостом: На связи, есть замечания" }),
    );
    expect(screen.getByText("Справочники не обновились — повторим автоматически")).toBeTruthy();
  });
});

describe("the office top bar and menu (design 2026-10)", () => {
  it("shows the host link as a chip with an icon and a word, beside the user's controls", async () => {
    renderOffice(fakeOfficeSession(), { link: ONLINE });
    const header = (await screen.findByRole("banner")) as HTMLElement;
    const chip = within(header).getByRole("button", { name: "Связь с хостом: На связи с хостом" });
    expect(within(chip).getByText("Хост на связи")).toBeTruthy();
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(header.querySelector(".host-status")).toBeNull();
    expect(header.querySelector(".office-header__actions .host-dot")).not.toBeNull();
  });

  it("names the page in the crumbs: the menu group, then the page", async () => {
    renderOffice(fakeOfficeSession());
    const header = (await screen.findByRole("banner")) as HTMLElement;
    const crumbs = within(header).getByRole("navigation", { name: "Вы здесь" });
    expect(crumbs.textContent).toBe("ОфисОбзор");
    expect(within(crumbs).getByText("Обзор").getAttribute("aria-current")).toBe("page");
  });

  it("keeps the operations on top and the settings after a rule, with «Доступ» merged into «Организация»", async () => {
    renderOffice(fakeOfficeSession());
    const nav = await screen.findByRole("navigation", { name: "Разделы офиса" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    const operations = ["Обзор", "Линии", "Смены", "Конфликты", "Товары", "Шаблоны"];
    const settings = [
      "Профиль",
      "SSCC",
      "Контрагенты",
      "Пользователи",
      "Резервные копии",
      "Информация",
    ];
    for (const label of [...operations, ...settings]) expect(labels).toContain(label);
    expect(labels).toHaveLength(17);
    const lastOperation = Math.max(...operations.map((label) => labels.indexOf(label)));
    const firstSetting = Math.min(...settings.map((label) => labels.indexOf(label)));
    expect(lastOperation).toBeLessThan(firstSetting);
    // One rule sets the settings block apart; the group names stand above their entries.
    expect(nav.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(within(nav).getByText("Организация")).toBeTruthy();
    expect(within(nav).getByText("Сервис")).toBeTruthy();
    expect(within(nav).queryByText("Доступ")).toBeNull();
    // «Пользователи» is the last entry of «Организация».
    expect(labels.indexOf("Пользователи")).toBe(labels.indexOf("Контрагенты") + 1);
    // Every entry has an icon.
    for (const link of within(nav).getAllByRole("link")) {
      expect(link.querySelector("svg")).not.toBeNull();
    }
  });

  it("shows a technologist only the entries their role may open", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    const nav = await screen.findByRole("navigation", { name: "Разделы офиса" });
    expect(within(nav).queryByRole("link", { name: "Пользователи" })).toBeNull();
    expect(within(nav).queryByRole("link", { name: "Устройства" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "Резервные копии" })).toBeTruthy();
  });

  it("collapses to icons below 1366 px, keeping every name, and opens with the toggle", async () => {
    const original = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
      renderOffice(fakeOfficeSession());
      const nav = await screen.findByRole("navigation", { name: "Разделы офиса" });
      expect(nav.className).toContain("office-menu--collapsed");
      // The name stays for a screen reader and as a tooltip.
      const link = within(nav).getByRole("link", { name: "Смены" });
      expect(link.getAttribute("title")).toBe("Смены");
      const toggle = screen.getByRole("button", { name: "Меню разделов" });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.getAttribute("aria-controls")).toBe(nav.id);
      fireEvent.click(toggle);
      expect(nav.className).not.toContain("office-menu--collapsed");
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(within(nav).getByRole("link", { name: "Смены" }).getAttribute("title")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
    }
  });

  it("stays open from 1366 px", async () => {
    const original = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
      renderOffice(fakeOfficeSession());
      const nav = await screen.findByRole("navigation", { name: "Разделы офиса" });
      expect(nav.className).not.toContain("office-menu--collapsed");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
    }
  });

  it("keeps every route and sorts items into settings by their section", () => {
    expect(OFFICE_NAV.filter(isSettingsItem).map((item) => item.to)).toEqual([
      "/org",
      "/sscc",
      "/counterparties",
      "/users",
      "/backups",
      "/import",
      "/about",
    ]);
    // Operations come first in the list too, so the menu reads in one order.
    const firstSetting = OFFICE_NAV.findIndex(isSettingsItem);
    expect(OFFICE_NAV.slice(firstSetting).every(isSettingsItem)).toBe(true);
  });
});
