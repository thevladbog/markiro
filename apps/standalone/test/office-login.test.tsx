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

  it("has the logo at the top left and the theme selector at the top right, in one header", () => {
    renderLogin();
    const top = document.querySelector(".office-login__top") as HTMLElement;
    expect(top.firstElementChild?.className).toContain("office-login__brand");
    expect(within(top).getByText("маркиро")).toBeTruthy();
    expect(top.lastElementChild?.className).toContain("office-login__tools");
    expect(top.lastElementChild?.querySelector(".theme-switcher")).not.toBeNull();
    // One card in the middle holds the form and the recent users; no second frame, no orbs.
    expect(document.querySelectorAll(".office-login__card")).toHaveLength(1);
    expect(
      document.querySelector(".office-login__recent")?.closest(".office-login__card"),
    ).not.toBeNull();
    expect(screen.getByRole("region", { name: "Ваше производство" })).toBeTruthy();
  });

  it("switches the theme from the selector: system, light, dark; the choice persists and applies", () => {
    renderLogin();
    const group = screen.getByRole("radiogroup", { name: "Тема оформления" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((item) => item.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "true"]);
    fireEvent.click(within(group).getByRole("radio", { name: "Светлая" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("markiro.theme")).toBe("light");
    fireEvent.click(within(group).getByRole("radio", { name: /Системная/ }));
    expect(localStorage.getItem("markiro.theme")).toBe("system");
    expect(["light", "dark"]).toContain(document.documentElement.dataset.theme);
    fireEvent.click(within(group).getByRole("radio", { name: "Тёмная" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("renders in the light theme too", () => {
    localStorage.setItem("markiro.theme", "light");
    renderLogin();
    expect(screen.getByRole("heading", { level: 2, name: "Вход в офис" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Светлая" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps the product and its version as a quiet brand footer: «Markiro Автоном 2.1.0»", async () => {
    renderLogin(undefined, "2.1.0");
    const product = await screen.findByText("Markiro Автоном 2.1.0");
    expect(product.className).toContain("office-login__product");
    expect(product.closest(".office-login__brand-footer")).not.toBeNull();
  });

  it("shows a green chip «Связь есть» when the host answers", () => {
    renderLogin(undefined, null, { state: "online", lastContactAt: 1, lastError: null, seq: 1 });
    const top = document.querySelector(".office-login__top") as HTMLElement;
    const chip = within(top).getByRole("status");
    expect(chip.className).toContain("office-chip--ok");
    expect(chip.textContent).toBe("Связь есть");
  });

  it("shows a red chip with the words «Связи нет» when the host is silent", () => {
    renderLogin(undefined, null, {
      state: "offline",
      lastContactAt: null,
      lastError: "unreachable",
      seq: 2,
    });
    const top = document.querySelector(".office-login__top") as HTMLElement;
    const chip = within(top).getByRole("status");
    expect(chip.className).toContain("office-chip--error");
    expect(chip.textContent).toBe("Связи нет");
    expect(chip.querySelector("svg")).not.toBeNull();
  });

  it("shows no chip before the shell has a status", () => {
    renderLogin();
    expect(
      within(document.querySelector(".office-login__top") as HTMLElement).queryByRole("status"),
    ).toBeNull();
  });

  it("marks both fields and says why above them when the host refuses the sign-in", async () => {
    const onLogin = vi.fn().mockRejectedValue(new Error("no"));
    renderLogin(onLogin);
    fireEvent.change(screen.getByLabelText("Логин"), { target: { value: "irina" } });
    fireEvent.change(screen.getByLabelText("Пароль"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByLabelText("Логин").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Пароль").getAttribute("aria-invalid")).toBe("true");
    expect(document.querySelector(".office-login__form")?.hasAttribute("data-failed")).toBe(true);
  });

  it("shows the typed password only while the eye is on", () => {
    renderLogin();
    const field = screen.getByLabelText("Пароль") as HTMLInputElement;
    expect(field.type).toBe("password");
    const eye = screen.getByRole("button", { name: "Показать пароль" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(eye);
    expect(field.type).toBe("text");
    expect(screen.getByRole("button", { name: "Скрыть пароль" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Скрыть пароль" }));
    expect(field.type).toBe("password");
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
    expect(pick.querySelector(".office-login__go")).toBeNull();
    // A one-word login gives one initial (the same rule as the top bar's avatar).
    expect(pick.querySelector(".office-login__avatar")?.textContent).toBe("I");
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
