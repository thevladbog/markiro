import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import { OfficeLogin } from "../src/office/OfficeLogin.js";
import { fakeOfficeSession, renderOffice } from "./support/office.js";
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
});
