import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { HostError } from "../src/host/client.js";
import type { OfficeUserRecord } from "../src/host/protocol.js";
import { Office } from "../src/office/Office.js";
import { OfficeSessionProvider } from "../src/office/office-session.js";
import { RequireRole } from "../src/office/RequireRole.js";
import {
  fakeOfficeSession,
  OFFICE_USERS,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const TECH_ID = TECHNOLOGIST.id;

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listUsers.mockResolvedValue(OFFICE_USERS);
  return session;
}

async function openUsers(session: FakeOfficeSession) {
  const view = renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Пользователи" }));
  await screen.findByText("Павел Орлов");
  return view;
}

function rowOf(login: string): HTMLElement {
  const row = screen.getByText(login).closest("tr");
  if (!row) throw new Error(`no row for ${login}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("office users", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is in the menu for administrators only", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Профиль" });
    expect(screen.queryByRole("link", { name: "Пользователи" })).toBeNull();
    expect(screen.queryByText("Доступ")).toBeNull();
  });

  it("shows no access to a role that may not open the page", () => {
    render(
      <OfficeSessionProvider value={fakeOfficeSession({ user: TECHNOLOGIST })}>
        <RequireRole roles={["admin"]}>
          <p>Секрет</p>
        </RequireRole>
      </OfficeSessionProvider>,
    );
    expect(screen.getByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByText("Секрет")).toBeNull();
  });

  it("closes the page when the user's role changes to technologist", async () => {
    const session = adminSession();
    const view = await openUsers(session);
    view.rerender(
      <ThemeProvider defaultTheme="dark">
        <Office session={{ ...session, user: { ...session.user, role: "technologist" } }} />
      </ThemeProvider>,
    );
    expect(await screen.findByText("Нет доступа")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Пользователи" })).toBeNull();
  });

  it("lists the users and marks the signed-in one", async () => {
    await openUsers(adminSession());
    const own = rowOf("admin");
    expect(within(own).getByText("это вы")).toBeTruthy();
    expect(within(own).getByText("Администратор")).toBeTruthy();
    expect(within(own).queryByRole("button", { name: /Задать пароль/ })).toBeNull();
    const tech = rowOf("tech");
    expect(within(tech).getByText("Технолог")).toBeTruthy();
    expect(within(tech).getByText("Входит в офис")).toBeTruthy();
    expect(
      within(tech).getByRole("button", { name: "Задать пароль пользователю tech" }),
    ).toBeTruthy();
  });

  it("adds a user", async () => {
    const session = adminSession();
    session.api.createUser.mockResolvedValue({
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      login: "anna",
      name: "Анна Козлова",
      role: "technologist",
      active: true,
      createdAt: "2026-09-26T10:00:00Z",
      rev: 9,
    });
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", " anna ");
    type("Имя", "Анна Козлова");
    type("Пароль", "anna long password");
    type("Повторите пароль", "anna long password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Пользователь anna добавлен.")).toBeTruthy();
    expect(session.api.createUser).toHaveBeenCalledWith("office-session-token", {
      login: "anna",
      name: "Анна Козлова",
      role: "technologist",
      password: "anna long password",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rowOf("anna")).toBeTruthy();
  });

  it("sorts a new user the way the host does: ASCII case folded, then by byte", async () => {
    const session = fakeOfficeSession();
    const aMinusBc: OfficeUserRecord = {
      id: "11111111-1111-4111-8111-111111111111",
      login: "a-bc",
      name: "Первая",
      role: "technologist",
      active: true,
      createdAt: "2026-09-26T09:00:00Z",
      rev: 1,
    };
    const abc: OfficeUserRecord = {
      id: "22222222-2222-4222-8222-222222222222",
      login: "abc",
      name: "Вторая",
      role: "technologist",
      active: true,
      createdAt: "2026-09-26T09:05:00Z",
      rev: 1,
    };
    session.api.listUsers.mockResolvedValue([aMinusBc, abc]);
    session.api.createUser.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      login: "A_bc",
      name: "Третья",
      role: "technologist",
      active: true,
      createdAt: "2026-09-26T09:10:00Z",
      rev: 1,
    });
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Пользователи" }));
    await screen.findByText("a-bc");
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", "A_bc");
    type("Имя", "Третья");
    type("Пароль", "another long password");
    type("Повторите пароль", "another long password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Пользователь A_bc добавлен.")).toBeTruthy();
    // The host orders by `login COLLATE NOCASE`: case folded first, then by
    // byte (`-` 0x2D < `_` 0x5F < `b` 0x62), so `A_bc` sorts between `a-bc`
    // and `abc` even though raw `A` (0x41) sorts before lowercase `a`
    // (0x61) — a `byLogin` without case folding, like the old
    // `localeCompare`, would put `A_bc` first instead.
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    const logins = rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
    expect(logins).toEqual(["a-bc", "A_bc", "abc"]);
  });

  it("re-reads the whole list after adding a user onto a list that failed to load", async () => {
    const session = fakeOfficeSession();
    session.api.listUsers
      .mockRejectedValueOnce(
        new HostError({ kind: "transport", code: "unreachable", message: "down" }),
      )
      .mockResolvedValueOnce(OFFICE_USERS);
    session.api.createUser.mockResolvedValue({
      id: "5d2f0a1c-3b4e-4f6a-8c9d-0e1f2a3b4c5d",
      login: "anna",
      name: "Анна Козлова",
      role: "technologist",
      active: true,
      createdAt: "2026-09-26T10:00:00Z",
      rev: 9,
    });
    renderOffice(session);
    fireEvent.click(await screen.findByRole("link", { name: "Пользователи" }));
    await screen.findByText(
      "Нет связи с хостом. Проверьте, что ПК-хост включён и служба запущена.",
    );
    // The header's "add" button stays even though the list failed to load.
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", "anna");
    type("Имя", "Анна Козлова");
    type("Пароль", "anna long password");
    type("Повторите пароль", "anna long password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Пользователь anna добавлен.")).toBeTruthy();
    await waitFor(() => expect(session.api.listUsers).toHaveBeenCalledTimes(2));
    // The re-read list (admin and tech), not a one-row list of just the new user.
    expect(await screen.findByText("Павел Орлов")).toBeTruthy();
    expect(rowOf("admin")).toBeTruthy();
  });

  it("says when the login is taken", async () => {
    const session = adminSession();
    session.api.createUser.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "this login is already taken",
        details: { constraint: "login" },
      }),
    );
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", "tech");
    type("Имя", "Павел Второй");
    type("Пароль", "another long password");
    type("Повторите пароль", "another long password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Этот логин уже занят")).toBeTruthy();
  });

  it("checks the repeated password before calling the host", async () => {
    const session = adminSession();
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить пользователя" }));
    type("Логин", "anna");
    type("Имя", "Анна Козлова");
    type("Пароль", "anna long password");
    type("Повторите пароль", "a different password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Пароли не совпадают")).toBeTruthy();
    expect(session.api.createUser).not.toHaveBeenCalled();
  });

  it("changes another user's role and access with the loaded revision", async () => {
    const session = adminSession();
    session.api.updateUser.mockResolvedValue({
      ...OFFICE_USERS[1]!,
      role: "admin",
      active: false,
      rev: 10,
    });
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя tech" }));
    fireEvent.click(within(dialog()).getByRole("radio", { name: "Администратор" }));
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "Может входить в офис" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Изменения сохранены.")).toBeTruthy();
    expect(session.api.updateUser).toHaveBeenCalledWith("office-session-token", TECH_ID, {
      name: "Павел Орлов",
      role: "admin",
      active: false,
      expectedRev: 3,
    });
    expect(within(rowOf("tech")).getByText("Выключен")).toBeTruthy();
    expect(session.refreshUser).not.toHaveBeenCalled();
  });

  it("lets administrators rename themselves but not change their own role or access", async () => {
    const session = adminSession();
    session.api.updateUser.mockResolvedValue({
      ...OFFICE_USERS[0]!,
      name: "Ирина Орлова",
      rev: 11,
    });
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя admin" }));
    expect(within(dialog()).getByRole("radio", { name: "Технолог" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(dialog()).getByRole("checkbox", { name: "Может входить в офис" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      within(dialog()).getByText("Свою роль может изменить только другой администратор."),
    ).toBeTruthy();
    expect(
      within(dialog()).getByText("Свой доступ может изменить только другой администратор."),
    ).toBeTruthy();
    type("Имя", "Ирина Орлова");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateUser).toHaveBeenCalledWith(
      "office-session-token",
      OFFICE_USERS[0]!.id,
      { name: "Ирина Орлова", role: "admin", active: true, expectedRev: 1 },
    );
    // The header shows the signed-in user's name: the shell reads it again.
    expect(session.refreshUser).toHaveBeenCalledTimes(1);
  });

  it("explains the last administrator rule", async () => {
    const session = adminSession();
    session.api.updateUser.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "last_admin",
        status: 409,
        message: "the last administrator cannot be demoted",
      }),
    );
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя tech" }));
    type("Имя", "Павел Орлов-Старший");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByText("Нельзя выключить или понизить последнего администратора."),
    ).toBeTruthy();
  });

  it("offers to load the users again after a stale change", async () => {
    const session = adminSession();
    session.api.updateUser.mockRejectedValueOnce(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 12 },
      }),
    );
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Изменить пользователя tech" }));
    type("Имя", "Павел Орлов-Старший");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    fireEvent.click(await screen.findByRole("button", { name: "Загрузить заново" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(session.api.listUsers).toHaveBeenCalledTimes(2));
  });

  it("sets another user's password", async () => {
    const session = adminSession();
    session.api.setUserPassword.mockResolvedValue(undefined);
    await openUsers(session);
    fireEvent.click(screen.getByRole("button", { name: "Задать пароль пользователю tech" }));
    expect(
      within(dialog()).getByText(
        "Пользователь войдёт с новым паролем; его сессии на всех устройствах закроются.",
      ),
    ).toBeTruthy();
    type("Пароль", "a brand new password");
    type("Повторите пароль", "a brand new password");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Задать пароль" }));
    expect(await screen.findByText("Пароль пользователя tech изменён.")).toBeTruthy();
    expect(session.api.setUserPassword).toHaveBeenCalledWith("office-session-token", TECH_ID, {
      password: "a brand new password",
    });
  });
});
