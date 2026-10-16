import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostStatus } from "../src/host/protocol.js";
import { ThemeProvider } from "@markiro/ui";

import { OfficeLogin } from "../src/office/OfficeLogin.js";
import { AboutProvider } from "../src/office/info/about-context.js";
import type { AboutApi } from "../src/office/info/about-api.js";
import { readRecentLogins, rememberLogin } from "../src/office/recent-logins.js";

function aboutWith(version: string | null): AboutApi {
  return {
    appVersion: version === null ? () => Promise.reject(new Error("none")) : async () => version,
    installRole: async () => "host_and_station",
    pairing: async () => null,
    hello: () => Promise.reject(new Error("none")),
    system: async () => ({ os: "Windows 11", arch: null, webview: null }),
    openLink: async () => undefined,
  } as unknown as AboutApi;
}

function renderLogin(
  onLogin = vi.fn().mockResolvedValue(undefined),
  version: string | null = null,
  link: HostStatus | null = null,
) {
  render(
    <ThemeProvider defaultTheme="dark">
      <AboutProvider value={aboutWith(version)}>
        <OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} link={link} />
      </AboutProvider>
    </ThemeProvider>,
  );
  return onLogin;
}

describe("the office sign-in (beta 3.2)", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it("says what the software is: the logo and the sign-in title", () => {
    renderLogin();
    expect(screen.getByText("маркиро")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Вход в офис" })).toBeTruthy();
  });

  it("has the logo at the top left and the theme switcher at the top right, in one header", () => {
    renderLogin();
    const top = document.querySelector(".office-login__top") as HTMLElement;
    expect(top.firstElementChild?.className).toContain("office-login__brand");
    expect(within(top).getByText("маркиро")).toBeTruthy();
    expect(top.lastElementChild?.className).toContain("theme-switcher");
    // No product line under the logo, no second frame around the card.
    expect(document.querySelector(".office-login__tagline")).toBeNull();
    expect(document.querySelectorAll(".office-login__card")).toHaveLength(2);
  });

  it("switches the theme from the selector: system, light, dark; the choice persists and applies", () => {
    renderLogin();
    const trigger = screen.getByRole("button", { name: "Тема оформления: Тёмная" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Тема оформления" });
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "true"]);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Светлая/ }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("markiro.theme")).toBe("light");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Тема оформления: Светлая" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Системная/ }));
    expect(localStorage.getItem("markiro.theme")).toBe("system");
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
    fireEvent.click(screen.getByRole("button", { name: "Тема оформления: Системная" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Тёмная/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("renders in the light theme too", () => {
    localStorage.setItem("markiro.theme", "light");
    renderLogin();
    expect(screen.getByRole("heading", { level: 2, name: "Вход в офис" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Тема оформления: Светлая" })).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps the version in the footer: «Markiro Автоном 2.1.0 · Офис»", async () => {
    renderLogin(undefined, "2.1.0");
    expect(await screen.findByText("Markiro Автоном 2.1.0")).toBeTruthy();
    const footer = document.querySelector(".office-login__footer") as HTMLElement;
    expect(footer.textContent).toContain("·Офис");
  });

  it("shows a green dot when the host answers and no phrase beside it", () => {
    renderLogin(undefined, null, { state: "online", lastContactAt: 1, lastError: null, seq: 1 });
    const footer = document.querySelector(".office-login__footer") as HTMLElement;
    expect(footer.querySelector(".status-dot--ok")).not.toBeNull();
    expect(within(footer).queryByText("Связи нет")).toBeNull();
  });

  it("shows a red dot with «Связи нет» right after it, before the rest of the footer", () => {
    renderLogin(undefined, null, {
      state: "offline",
      lastContactAt: null,
      lastError: "unreachable",
      seq: 2,
    });
    const footer = document.querySelector(".office-login__footer") as HTMLElement;
    const children = Array.from(footer.children);
    expect(children[0]?.className).toContain("status-dot--error");
    expect(children[1]?.textContent).toBe("Связи нет");
    expect(children[2]?.textContent).toBe("Markiro Автоном");
  });

  it("shows the host link as a small dot in the footer", () => {
    renderLogin(undefined, null, { state: "online", lastContactAt: 1, lastError: null, seq: 1 });
    expect(screen.getByRole("img", { name: "На связи с хостом" })).toBeTruthy();
  });

  it("offers no recent users on a PC nobody signed in on, and says where they will appear", () => {
    renderLogin();
    const aside = screen.getByRole("complementary", { name: "Недавние на этом ПК" });
    expect(within(aside).getByText(/Здесь появятся пользователи/)).toBeTruthy();
    expect(within(aside).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("lists the users who signed in here, and a click fills the login and moves to the password", async () => {
    rememberLogin("irina");
    rememberLogin("petr");
    renderLogin();
    const aside = screen.getByRole("complementary", { name: "Недавние на этом ПК" });
    expect(within(aside).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(aside).getByRole("button", { name: "Войти как irina" }));
    expect((screen.getByLabelText("Логин") as HTMLInputElement).value).toBe("irina");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Пароль")));
  });

  it("marks the user whose login is in the field, and clears the whole list", () => {
    rememberLogin("irina");
    rememberLogin("petr");
    renderLogin();
    const pick = screen.getByRole("button", { name: "Войти как irina" });
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    expect(pick.querySelector(".office-login__check")).not.toBeNull();
    expect(pick.textContent).toContain("IR");
    fireEvent.click(screen.getByRole("button", { name: "Очистить список" }));
    expect(screen.queryByRole("button", { name: "Войти как irina" })).toBeNull();
    expect(readRecentLogins()).toEqual([]);
  });

  it("remembers a login only after the host let the person in, and never the password", async () => {
    const onLogin = vi.fn().mockRejectedValueOnce(new Error("no")).mockResolvedValue(undefined);
    renderLogin(onLogin);
    fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "irina" } });
    fireEvent.change(screen.getByLabelText("Пароль"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(readRecentLogins()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(readRecentLogins()).toEqual(["irina"]));
    expect(localStorage.getItem("markiro.office.recentLogins")).not.toContain("correct horse");
  });
});
