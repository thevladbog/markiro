import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import type { OfficeUser } from "../src/host/protocol.js";
import { Office } from "../src/office/Office.js";
import { OfficeLogin } from "../src/office/OfficeLogin.js";
import type { OfficeSessionValue } from "../src/office/office-session.js";
import { SESSION } from "./support/fixtures.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function sessionFor(user: OfficeUser = SESSION.user) {
  return {
    user,
    call: <T,>(operation: (token: string) => Promise<T>) => operation(SESSION.token),
    leave: vi.fn(),
    logout: vi.fn(async () => {}),
    changePassword: vi.fn(async () => {}),
  } satisfies OfficeSessionValue;
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
});

describe("Office", () => {
  // ThemeProvider keeps the chosen theme in localStorage; start each test dark.
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  function renderOffice(session: OfficeSessionValue) {
    return render(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} />
      </ThemeProvider>,
    );
  }

  it("shows who is signed in and the sections of their role", async () => {
    renderOffice(sessionFor());
    expect(await screen.findByText("Ирина Смирнова")).toBeTruthy();
    expect(screen.getByText("администратор")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Обзор" })).toBeTruthy();
    expect(screen.getByText("Вы вошли как Ирина Смирнова.")).toBeTruthy();
    expect(screen.getByText("Роль: администратор.")).toBeTruthy();
  });

  it("names the technologist role", async () => {
    renderOffice(sessionFor({ ...SESSION.user, role: "technologist" }));
    expect(await screen.findByText("технолог")).toBeTruthy();
  });

  it("goes back to the floor and signs out from the header", async () => {
    const session = sessionFor();
    renderOffice(session);
    fireEvent.click(await screen.findByRole("button", { name: "В цех" }));
    expect(session.leave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    expect(session.logout).toHaveBeenCalledTimes(1);
  });

  it("switches the theme", async () => {
    renderOffice(sessionFor());
    fireEvent.click(await screen.findByRole("button", { name: "Включить светлую тему" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Включить тёмную тему" })).toBeTruthy();
  });
});

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  function renderOffice(session: OfficeSessionValue) {
    return render(
      <ThemeProvider defaultTheme="dark">
        <Office session={session} />
      </ThemeProvider>,
    );
  }

  async function openDialog(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Сменить пароль" }));
    await screen.findByText("Смена пароля");
  }

  it("changes the password with the current one", async () => {
    const session = sessionFor();
    renderOffice(session);
    await openDialog();
    type("Текущий пароль", "correct horse battery");
    type("Новый пароль", "another long password");
    type("Повторите новый пароль", "another long password");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    await waitFor(() =>
      expect(session.changePassword).toHaveBeenCalledWith({
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
    const session = sessionFor();
    renderOffice(session);
    await openDialog();
    type("Текущий пароль", "correct horse battery");
    type("Новый пароль", "another long password");
    type("Повторите новый пароль", "a different one here");
    fireEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeTruthy();
    expect(session.changePassword).not.toHaveBeenCalled();
  });

  it("says when the current password is wrong", async () => {
    const session = sessionFor();
    session.changePassword.mockRejectedValueOnce(
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
});
