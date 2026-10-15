import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HostStatus } from "../src/host/protocol.js";
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
    <AboutProvider value={aboutWith(version)}>
      <OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} link={link} />
    </AboutProvider>,
  );
  return onLogin;
}

describe("the office sign-in (beta 3.2)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("says what the software is: the product, a tagline and the sign-in title", () => {
    renderLogin();
    expect(screen.getByText("маркиро")).toBeTruthy();
    expect(screen.getByText("Автоном · офис")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Вход в офис" })).toBeTruthy();
  });

  it("keeps the version in a quiet footer when the shell tells it", async () => {
    renderLogin(undefined, "2.1.0");
    expect(await screen.findByText(/Версия 2\.1\.0/)).toBeTruthy();
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
    expect(pick.textContent).toContain("✓");
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
