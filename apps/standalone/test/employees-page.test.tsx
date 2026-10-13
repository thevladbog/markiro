import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { verifyPhc } from "@markiro/domain";

import { HostError } from "../src/host/client.js";
import type { EmployeeRecord, OfficeOperator, OperatorCreate } from "../src/host/protocol.js";
import {
  fakeOfficeSession,
  renderOffice,
  TECHNOLOGIST,
  type FakeOfficeSession,
} from "./support/office.js";

const ANNA_OP: OfficeOperator = {
  id: "8a3c1f0e-2b4d-4e6f-9a1b-3c5d7e9f1a2b",
  login: "0042",
  name: "Анна Кузнецова",
  role: "Упаковщик",
  active: true,
  hasPin: true,
  badges: [],
  rev: 55,
};
const BORIS_OP: OfficeOperator = {
  id: "5b9d2e4f-6a1c-4d3e-8f2a-7b6c5d4e3f21",
  login: "100",
  name: "Борис Орлов",
  role: null,
  active: false,
  hasPin: true,
  badges: [],
  rev: 40,
};
const ANNA: EmployeeRecord = {
  id: "4f6a8c2e-1b3d-4e5f-8a7b-9c0d1e2f3a4b",
  name: "Анна Кузнецова",
  role: "Упаковщик",
  operatorId: ANNA_OP.id,
  archived: false,
  rev: 61,
};
const PETR: EmployeeRecord = {
  id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  name: "Пётр Иванов",
  role: "Кладовщик",
  operatorId: null,
  archived: false,
  rev: 62,
};
const OLGA: EmployeeRecord = {
  id: "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b",
  name: "Ольга Белова",
  role: null,
  operatorId: null,
  archived: true,
  rev: 30,
};

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listEmployees.mockResolvedValue([OLGA, PETR, ANNA]);
  session.api.listOperators.mockResolvedValue([BORIS_OP, ANNA_OP]);
  return session;
}

async function openEmployees(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Сотрудники" }));
  await screen.findByText("Пётр Иванов");
}

function names(): (string | null | undefined)[] {
  const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
  return rows.map((row) => within(row).getAllByRole("cell")[0]?.textContent);
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table")).getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

function optionsOf(label: string): string[] {
  const select = screen.getByLabelText(label);
  return [...select.querySelectorAll("option")].map((option) => option.textContent ?? "");
}

describe("office employees", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("is not in a technologist's menu", async () => {
    renderOffice(fakeOfficeSession({ user: TECHNOLOGIST }));
    await screen.findByRole("link", { name: "Контрагенты" });
    expect(screen.queryByRole("link", { name: "Сотрудники" })).toBeNull();
  });

  it("lists the employees with their operators, archived ones last", async () => {
    await openEmployees(adminSession());
    expect(names()).toEqual(["Анна Кузнецова", "Пётр Иванов", "Ольга Белова"]);
    expect(within(rowOf("Пётр Иванов")).getByText("Нет доступа к станции")).toBeTruthy();
    expect(within(rowOf("Ольга Белова")).getByText("В архиве")).toBeTruthy();
    // An archived employee is linked to nobody, so the row offers no link.
    expect(
      within(rowOf("Ольга Белова")).queryByRole("button", { name: /^Оператор сотрудника/ }),
    ).toBeNull();
    expect(within(rowOf("Анна Кузнецова")).getByText("0042 · Анна Кузнецова")).toBeTruthy();
  });

  it("finds employees by an operator's number and filters by the link", async () => {
    await openEmployees(adminSession());
    type("Поиск", "0042");
    expect(names()).toEqual(["Анна Кузнецова"]);
    type("Поиск", "");
    fireEvent.change(screen.getByLabelText("Доступ к станции"), { target: { value: "unlinked" } });
    expect(names()).toEqual(["Пётр Иванов"]);
    fireEvent.change(screen.getByLabelText("Доступ к станции"), { target: { value: "archived" } });
    expect(names()).toEqual(["Ольга Белова"]);
    type("Поиск", "нет такого");
    expect(screen.getByText("Никого не найдено.")).toBeTruthy();
  });

  it("adds an employee, sending each field by name", async () => {
    const session = adminSession();
    const created: EmployeeRecord = { ...PETR, id: "0f1e2d3c-4b5a-4968-8776-655443322110" };
    session.api.createEmployee.mockResolvedValue({ ...created, name: "Вера Лебедева" });
    await openEmployees(session);
    fireEvent.click(screen.getByRole("button", { name: "Добавить сотрудника" }));
    type("ФИО", " Вера Лебедева ");
    type("Должность", "  ");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await screen.findByText("Сотрудник «Вера Лебедева» добавлен.");
    expect(session.api.createEmployee).toHaveBeenCalledWith(expect.any(String), {
      name: "Вера Лебедева",
      role: null,
      operatorId: null,
    });
  });

  it("links an employee to an operator nobody holds, the turned-off ones included", async () => {
    const session = adminSession();
    session.api.updateEmployee.mockResolvedValue({ ...PETR, operatorId: BORIS_OP.id, rev: 63 });
    await openEmployees(session);
    fireEvent.click(
      within(rowOf("Пётр Иванов")).getByRole("button", {
        name: "Оператор сотрудника «Пётр Иванов»",
      }),
    );
    // Анна's operator is hers already, so it is not offered.
    expect(optionsOf("Оператор")).toEqual([
      "Выберите оператора",
      "Новый оператор…",
      "100 · Борис Орлов (выключен)",
    ]);
    fireEvent.change(screen.getByLabelText("Оператор"), { target: { value: BORIS_OP.id } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Связать" }));
    await screen.findByText("Сотрудник «Пётр Иванов» связан с оператором 100 · Борис Орлов.");
    expect(session.api.updateEmployee).toHaveBeenCalledWith(expect.any(String), PETR.id, {
      name: "Пётр Иванов",
      role: "Кладовщик",
      operatorId: BORIS_OP.id,
      archived: false,
      expectedRev: 62,
    });
    expect(within(rowOf("Пётр Иванов")).getByText("100 · Борис Орлов (выключен)")).toBeTruthy();
  });

  it("says who holds an operator another office linked meanwhile", async () => {
    const session = adminSession();
    session.api.updateEmployee.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "conflict",
        status: 409,
        message: "taken",
        details: { constraint: "operator", employeeId: ANNA.id },
      }),
    );
    await openEmployees(session);
    fireEvent.click(
      within(rowOf("Пётр Иванов")).getByRole("button", {
        name: "Оператор сотрудника «Пётр Иванов»",
      }),
    );
    fireEvent.change(screen.getByLabelText("Оператор"), { target: { value: BORIS_OP.id } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Связать" }));
    expect(
      await within(dialog()).findByText("Этот оператор уже связан с другим сотрудником"),
    ).toBeTruthy();
  });

  it("unlinks an operator, saying the station sign-in does not change", async () => {
    const session = adminSession();
    session.api.updateEmployee.mockResolvedValue({ ...ANNA, operatorId: null, rev: 64 });
    await openEmployees(session);
    fireEvent.click(
      within(rowOf("Анна Кузнецова")).getByRole("button", {
        name: "Оператор сотрудника «Анна Кузнецова»",
      }),
    );
    expect(
      within(dialog()).getByText(
        "Сотрудник «Анна Кузнецова» и оператор 0042 · Анна Кузнецова больше не будут связаны. Вход оператора на станциях не меняется.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отвязать" }));
    await screen.findByText("Сотрудник «Анна Кузнецова» отвязан от оператора.");
    expect(session.api.updateEmployee).toHaveBeenCalledWith(expect.any(String), ANNA.id, {
      name: "Анна Кузнецова",
      role: "Упаковщик",
      operatorId: null,
      archived: false,
      expectedRev: 61,
    });
  });

  it("archives a linked employee together with the unlink and warns the operator still signs in", async () => {
    const session = adminSession();
    session.api.updateEmployee.mockResolvedValue({
      ...ANNA,
      operatorId: null,
      archived: true,
      rev: 64,
    });
    await openEmployees(session);
    fireEvent.click(
      within(rowOf("Анна Кузнецова")).getByRole("button", {
        name: "Изменить сотрудника «Анна Кузнецова»",
      }),
    );
    fireEvent.click(within(dialog()).getByRole("checkbox", { name: "В архиве" }));
    expect(
      within(dialog()).getByText(
        "Сотрудник будет отвязан от оператора 0042 · Анна Кузнецова. Оператор по-прежнему сможет входить на станциях — выключите его на странице «Операторы», если человек больше не работает.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Изменения сохранены.");
    expect(session.api.updateEmployee).toHaveBeenCalledWith(expect.any(String), ANNA.id, {
      name: "Анна Кузнецова",
      role: "Упаковщик",
      operatorId: null,
      archived: true,
      expectedRev: 61,
    });
  });

  it("creates an operator from an employee and links the two", async () => {
    const session = adminSession();
    const vera: OfficeOperator = {
      ...BORIS_OP,
      id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      login: "0077",
      name: "Пётр Иванов",
      role: "Кладовщик",
      active: true,
      rev: 70,
    };
    session.api.createOperator.mockResolvedValue(vera);
    session.api.updateEmployee.mockResolvedValue({ ...PETR, operatorId: vera.id, rev: 71 });
    await openEmployees(session);
    fireEvent.click(
      within(rowOf("Пётр Иванов")).getByRole("button", {
        name: "Оператор сотрудника «Пётр Иванов»",
      }),
    );
    fireEvent.change(screen.getByLabelText("Оператор"), { target: { value: "new" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Создать оператора" }));
    // The operator form opens with the employee's name and role.
    await screen.findByRole("dialog", { name: "Новый оператор" });
    expect((screen.getByLabelText("Имя") as HTMLInputElement).value).toBe("Пётр Иванов");
    expect((screen.getByLabelText("Должность") as HTMLInputElement).value).toBe("Кладовщик");
    type("Табельный номер", "0077");
    type("PIN", "4821");
    type("Повторите PIN", "4821");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await screen.findByText(
      "Оператор 0077 · Пётр Иванов добавлен и связан с сотрудником «Пётр Иванов».",
    );
    const body = session.api.createOperator.mock.calls[0]?.[1] as OperatorCreate;
    expect(body.name).toBe("Пётр Иванов");
    expect(await verifyPhc("4821", body.pinPhc)).toBe(true);
    expect(session.api.updateEmployee).toHaveBeenCalledWith(expect.any(String), PETR.id, {
      name: "Пётр Иванов",
      role: "Кладовщик",
      operatorId: vera.id,
      archived: false,
      expectedRev: 62,
    });
  });

  it("says so when the new operator was created but the link failed", async () => {
    const session = adminSession();
    const vera: OfficeOperator = {
      ...BORIS_OP,
      id: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      login: "0077",
      name: "Пётр Иванов",
      active: true,
    };
    session.api.createOperator.mockResolvedValue(vera);
    session.api.updateEmployee.mockRejectedValue(
      new HostError({
        kind: "api",
        code: "stale_revision",
        status: 409,
        message: "stale",
        details: { currentRev: 70 },
      }),
    );
    await openEmployees(session);
    fireEvent.click(
      within(rowOf("Пётр Иванов")).getByRole("button", {
        name: "Оператор сотрудника «Пётр Иванов»",
      }),
    );
    fireEvent.change(screen.getByLabelText("Оператор"), { target: { value: "new" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Создать оператора" }));
    await screen.findByRole("dialog", { name: "Новый оператор" });
    type("Табельный номер", "0077");
    type("PIN", "4821");
    type("Повторите PIN", "4821");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Добавить" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          /^Оператор 0077 · Пётр Иванов добавлен, но не связан с сотрудником «Пётр Иванов»/,
        ),
      ).toBeTruthy(),
    );
  });
});
