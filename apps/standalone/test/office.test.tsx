import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import { Office } from "../src/office/Office.js";
import { OfficeLogin } from "../src/office/OfficeLogin.js";
import type { WindowMode } from "../src/office/window-mode.js";
import {
  fakeOfficeSession,
  ORG_PROFILE,
  quietLabelRendering,
  renderOffice,
  TECHNOLOGIST,
} from "./support/office.js";
import { SESSION } from "./support/fixtures.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("OfficeLogin", () => {
  it("signs in with the trimmed login", async () => {
    const onLogin = vi.fn().mockResolvedValue(undefined);
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    type("Логин", " admin ");
    type("Пароль", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({ login: "admin", password: "correct horse battery" }),
    );
  });

  it("asks for both fields before calling the host", async () => {
    const onLogin = vi.fn();
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findAllByText("Заполните поле")).toHaveLength(2);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("refuses a broken character in the login or the password before calling the host", async () => {
    // An unpaired surrogate cannot cross the IPC: the call would fail as a
    // lost connection, so the form names the field instead.
    const onLogin = vi.fn();
    render(<OfficeLogin notice={null} onLogin={onLogin} onBack={vi.fn()} />);
    type("Логин", "admin\ud800");
    type("Пароль", "correct horse battery\udc00");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(
      await screen.findByText("В пароле есть повреждённый символ — наберите пароль заново"),
    ).toBeTruthy();
    expect(
      screen.getByText("3–64 символа: латиница, цифры, точка, дефис, подчёркивание"),
    ).toBeTruthy();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it.each([
    [
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "wrong login or password",
        details: { credential: "password" },
      }),
      "Неверный логин или пароль.",
    ],
    [
      new HostError({ kind: "api", code: "rate_limited", status: 429, message: "slow down" }),
      "Слишком много попыток. Подождите минуту и попробуйте снова.",
    ],
    [
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    ],
  ])("explains a failed sign-in (%#)", async (error, text) => {
    render(
      <OfficeLogin notice={null} onLogin={vi.fn().mockRejectedValue(error)} onBack={vi.fn()} />,
    );
    type("Логин", "admin");
    type("Пароль", "wrong");
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it("says why the session ended and goes back to the floor", () => {
    const onBack = vi.fn();
    render(<OfficeLogin notice="session_ended" onLogin={vi.fn()} onBack={onBack} />);
    expect(screen.getByText("Сессия офиса закончилась. Войдите снова.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "В цех" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("says the host was already set up when the wizard found it initialized", () => {
    render(<OfficeLogin notice="already_initialized" onLogin={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText("Хост уже настроен. Войдите в офис.")).toBeTruthy();
  });
});

describe("Office", () => {
  // ThemeProvider keeps the chosen theme in localStorage; start each test dark.
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows who is signed in and the sections of their role", async () => {
    renderOffice(fakeOfficeSession());
    expect(await screen.findByText("Ирина Смирнова")).toBeTruthy();
    expect(screen.getByText("администратор")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Обзор" })).toBeTruthy();
    expect(screen.getByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.getByText("Роль: администратор.")).toBeTruthy();
  });

  it("names the technologist role", async () => {
    renderOffice(fakeOfficeSession({ user: { ...SESSION.user, role: "technologist" } }));
    expect(await screen.findByText("технолог")).toBeTruthy();
  });

  it("leaves for the floor from the header, ending the session", async () => {
    const session = fakeOfficeSession();
    renderOffice(session);
    fireEvent.click(await screen.findByRole("button", { name: "Выйти в цех" }));
    expect(session.logout).toHaveBeenCalledTimes(1);
    // One way out: no button that would hide the office and keep the session.
    expect(screen.queryByRole("button", { name: "В цех" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull();
  });

  it("switches the theme", async () => {
    renderOffice(fakeOfficeSession());
    const toggle = await screen.findByRole("button", { name: "Включить светлую тему" });
    expect(toggle.querySelector('[aria-hidden="true"]')?.textContent).toBe("☀");
    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Включить тёмную тему" })).toBeTruthy();
  });

  it("offers the organization profile to both roles", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    expect(await screen.findByRole("link", { name: "Профиль" })).toBeTruthy();
    expect(screen.getByText("Организация")).toBeTruthy();
  });

  it("re-reads the signed-in user on a new host revision and leaves the open page alone", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    const view = renderOffice(session, { hostRevision: 3 });
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    await screen.findByLabelText("Название организации");
    // The revision the office opened with is not news.
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
    expect(session.refreshUser).not.toHaveBeenCalled();

    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} hostRevision={4} labels={quietLabelRendering()} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(session.refreshUser).toHaveBeenCalledTimes(1));
    // The open form is not reloaded under the user.
    expect(session.api.getOrg).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the page after a menu navigation", async () => {
    const session = fakeOfficeSession();
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Профиль" }));
    await screen.findByRole("heading", { name: "Профиль организации" });
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

describe("«Оконный режим» in the office header", () => {
  /** Kiosk mode as `App` gives an administrator; `leave` says the window left it. */
  function windowMode(mode: WindowMode["mode"]) {
    return { mode, leave: vi.fn<WindowMode["leave"]>(async () => true) };
  }

  it("is offered to an administrator only while the window is locked", async () => {
    const { unmount } = renderOffice(fakeOfficeSession(), { windowMode: windowMode("locked") });
    expect(await screen.findByRole("button", { name: "Оконный режим" })).toBeTruthy();
    unmount();

    for (const [user, mode] of [
      [SESSION.user, windowMode("windowed")],
      [TECHNOLOGIST, windowMode("locked")],
      [SESSION.user, null],
    ] as const) {
      const view = renderOffice(fakeOfficeSession({ user }), { windowMode: mode });
      expect(await screen.findByRole("button", { name: "Выйти в цех" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
      view.unmount();
    }
  });

  it("asks first, reads the user from the host, then leaves kiosk mode", async () => {
    const session = fakeOfficeSession();
    session.api.officeMe.mockResolvedValue(SESSION.user);
    const mode = windowMode("locked");
    renderOffice(session, { windowMode: mode });
    fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
    expect(
      screen.getByText(
        "Окно станции получит рамку и кнопку на панели задач, его можно будет свернуть и закрыть. Киоск-режим вернётся, когда вы выйдете из офиса.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(mode.leave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Оконный режим" }));
    fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
    await waitFor(() => expect(mode.leave).toHaveBeenCalledTimes(1));
    expect(session.api.officeMe).toHaveBeenCalledWith(SESSION.token);
    await waitFor(() => expect(screen.queryByText("Перейти в оконный режим?")).toBeNull());
  });

  it("moves focus to the office page when the window is an ordinary one and the button is gone", async () => {
    const session = fakeOfficeSession();
    session.api.officeMe.mockResolvedValue(SESSION.user);
    // As `App` gives it: the button goes away once the shell has confirmed the new mode.
    function Leaving() {
      const [mode, setMode] = useState<WindowMode["mode"]>("locked");
      const windowMode = useMemo<WindowMode>(
        () => ({
          mode,
          leave: async () => {
            setMode("windowed");
            return true;
          },
        }),
        [mode],
      );
      return <Office session={session} labels={quietLabelRendering()} windowMode={windowMode} />;
    }
    render(
      <ThemeProvider defaultTheme="dark">
        <Leaving />
      </ThemeProvider>,
    );
    const open = await screen.findByRole("button", { name: "Оконный режим" });
    open.focus();
    fireEvent.click(open);
    fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
    await waitFor(() => expect(screen.queryByText("Перейти в оконный режим?")).toBeNull());
    expect(screen.queryByRole("button", { name: "Оконный режим" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("main")));
  });

  it("keeps the window locked when the host says the user is no longer an administrator", async () => {
    const session = fakeOfficeSession();
    session.api.officeMe.mockResolvedValue({ ...SESSION.user, role: "technologist" });
    const mode = windowMode("locked");
    renderOffice(session, { windowMode: mode });
    fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
    fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
    expect(await screen.findByText("Оконный режим доступен только администратору.")).toBeTruthy();
    expect(mode.leave).not.toHaveBeenCalled();
    expect(session.refreshUser).toHaveBeenCalledTimes(1);
  });

  it("keeps the window locked when the host cannot be asked", async () => {
    const session = fakeOfficeSession();
    session.api.officeMe.mockRejectedValue(
      new HostError({ kind: "transport", code: "unreachable", message: "down" }),
    );
    const mode = windowMode("locked");
    renderOffice(session, { windowMode: mode });
    fireEvent.click(await screen.findByRole("button", { name: "Оконный режим" }));
    fireEvent.click(screen.getByRole("button", { name: "Перейти в оконный режим" }));
    expect(
      await screen.findByText(
        "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
      ),
    ).toBeTruthy();
    expect(mode.leave).not.toHaveBeenCalled();
  });
});

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  async function openDialog(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Сменить пароль" }));
    await screen.findByText("Смена пароля");
  }

  function fill(current: string, next: string, repeat = next): void {
    type("Текущий пароль", current);
    type("Новый пароль", next);
    type("Повторите новый пароль", repeat);
  }

  it("changes the password with the current one", async () => {
    const session = fakeOfficeSession();
    session.api.officeChangePassword.mockResolvedValue(undefined);
    renderOffice(session);
    await openDialog();
    type("Текущий пароль", "correct horse battery");
    type("Новый пароль", "another long password");
    type("Повторите новый пароль", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    await waitFor(() =>
      expect(session.api.officeChangePassword).toHaveBeenCalledWith("office-session-token", {
        currentPassword: "correct horse battery",
        newPassword: "another long password",
      }),
    );
    expect(
      await screen.findByText("Пароль изменён. На других устройствах нужно войти заново."),
    ).toBeTruthy();
    expect(screen.queryByText("Смена пароля")).toBeNull();
  });

  it("checks the repeated password before calling the host", async () => {
    const session = fakeOfficeSession();
    renderOffice(session);
    await openDialog();
    type("Текущий пароль", "correct horse battery");
    type("Новый пароль", "another long password");
    type("Повторите новый пароль", "a different one here");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeTruthy();
    expect(session.api.officeChangePassword).not.toHaveBeenCalled();
  });

  it("refuses a broken character in the current password before calling the host", async () => {
    const session = fakeOfficeSession();
    renderOffice(session);
    await openDialog();
    fill("correct horse battery\ud800", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(
      await screen.findByText("В пароле есть повреждённый символ — наберите пароль заново"),
    ).toBeTruthy();
    expect(session.api.officeChangePassword).not.toHaveBeenCalled();
  });

  it("says when the current password is wrong", async () => {
    const session = fakeOfficeSession();
    session.api.officeChangePassword.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "unauthorized",
        status: 401,
        message: "the current password is wrong",
        details: { credential: "password" },
      }),
    );
    renderOffice(session);
    await openDialog();
    type("Текущий пароль", "not the password");
    type("Новый пароль", "another long password");
    type("Повторите новый пароль", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Текущий пароль неверен.")).toBeTruthy();
  });

  it("checks the new password's length before calling the host", async () => {
    const session = fakeOfficeSession();
    renderOffice(session);
    await openDialog();
    fill("correct horse battery", "short");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Пароль — от 8 до 128 символов")).toBeTruthy();
    expect(session.api.officeChangePassword).not.toHaveBeenCalled();
  });

  it("puts the host's refusal of the new password under its field", async () => {
    const session = fakeOfficeSession();
    session.api.officeChangePassword.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "validation_failed",
        status: 400,
        message: "the password must be 8-128 characters",
        details: { field: "newPassword" },
      }),
    );
    renderOffice(session);
    await openDialog();
    fill("correct horse battery", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Пароль — от 8 до 128 символов")).toBeTruthy();
  });

  it("explains any other failure above the form and stays open", async () => {
    const session = fakeOfficeSession();
    session.api.officeChangePassword.mockRejectedValueOnce(
      new HostError({ kind: "api", code: "rate_limited", status: 429, message: "slow down" }),
    );
    renderOffice(session);
    await openDialog();
    fill("correct horse battery", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(
      await screen.findByText("Слишком много попыток. Подождите минуту и попробуйте снова."),
    ).toBeTruthy();
    expect(screen.getByText("Смена пароля")).toBeTruthy();
  });

  it("starts empty again after being cancelled", async () => {
    renderOffice(fakeOfficeSession());
    await openDialog();
    type("Текущий пароль", "correct horse battery");
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByText("Смена пароля")).toBeNull();
    await openDialog();
    expect(screen.getByLabelText("Текущий пароль")).toHaveProperty("value", "");
  });

  it("cannot be closed while the change is being sent", async () => {
    const session = fakeOfficeSession();
    let finish: () => void = () => undefined;
    session.api.officeChangePassword.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    renderOffice(session);
    await openDialog();
    fill("correct horse battery", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    await waitFor(() => expect(session.api.officeChangePassword).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.getByText("Смена пароля")).toBeTruthy();
    finish();
    expect(
      await screen.findByText("Пароль изменён. На других устройствах нужно войти заново."),
    ).toBeTruthy();
  });

  it("keeps the password notice on the page it was changed on", async () => {
    const session = fakeOfficeSession();
    session.api.officeChangePassword.mockResolvedValue(undefined);
    session.api.getOrg.mockResolvedValue(ORG_PROFILE);
    renderOffice(session);
    await openDialog();
    fill("correct horse battery", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    const notice = "Пароль изменён. На других устройствах нужно войти заново.";
    expect(await screen.findByText(notice)).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Профиль" }));
    await screen.findByRole("heading", { name: "Профиль организации" });
    expect(screen.queryByText(notice)).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Обзор" }));
    await screen.findByText("Вы вошли как Ирина Смирнова.");
    expect(screen.queryByText(notice)).toBeNull();
  });
});
