import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { EmployeeRecord, OfficeOperator } from "../src/host/protocol.js";
import { fakeOfficeSession, renderOffice, type FakeOfficeSession } from "./support/office.js";
import { chooseValue, optionTexts } from "./support/select.js";
import { pressRowAction } from "./support/row-menu.js";

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
  active: true,
  hasPin: true,
  badges: [],
  rev: 40,
};
const ANNA: EmployeeRecord = {
  id: "4f6a8c2e-1b3d-4e5f-8a7b-9c0d1e2f3a4b",
  name: "Анна Кузнецова-Смирнова",
  role: "Упаковщик",
  operatorId: ANNA_OP.id,
  archived: false,
  rev: 61,
};
const PETR: EmployeeRecord = {
  id: "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
  name: "Пётр Иванов",
  role: null,
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

function adminSession(): FakeOfficeSession {
  const session = fakeOfficeSession();
  session.api.listOperators.mockResolvedValue([ANNA_OP, BORIS_OP]);
  session.api.listEmployees.mockResolvedValue([ANNA, PETR, OLGA]);
  return session;
}

async function openOperators(session: FakeOfficeSession): Promise<void> {
  renderOffice(session);
  fireEvent.click(await screen.findByRole("link", { name: "Операторы" }));
  await screen.findByText("Борис Орлов");
}

function rowOf(name: string): HTMLElement {
  const row = within(screen.getByRole("table")).getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog");
}

describe("office operators: the linked employee", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
  });

  it("shows each operator's employee", async () => {
    await openOperators(adminSession());
    expect(within(rowOf("Анна Кузнецова")).getByText("Анна Кузнецова-Смирнова")).toBeTruthy();
    expect(within(rowOf("Борис Орлов")).getByText("Не связан")).toBeTruthy();
  });

  it("links an operator to an employee in use and linked to nobody", async () => {
    const session = adminSession();
    session.api.updateEmployee.mockResolvedValue({ ...PETR, operatorId: BORIS_OP.id, rev: 63 });
    await openOperators(session);
    pressRowAction(within(rowOf("Борис Орлов")), "Сотрудник оператора «Борис Орлов»");
    // Анна is linked already and Ольга is archived: neither is offered.
    expect(optionTexts("Сотрудник")).toEqual([
      "Выберите сотрудника",
      "Новый сотрудник «Борис Орлов»",
      "Пётр Иванов",
    ]);
    chooseValue("Сотрудник", PETR.id);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Связать" }));
    await screen.findByText("Оператор «Борис Орлов» связан с сотрудником «Пётр Иванов».");
    expect(session.api.updateEmployee).toHaveBeenCalledWith(expect.any(String), PETR.id, {
      name: "Пётр Иванов",
      role: null,
      operatorId: BORIS_OP.id,
      archived: false,
      expectedRev: 62,
    });
    expect(within(rowOf("Борис Орлов")).getByText("Пётр Иванов")).toBeTruthy();
    // The operator itself was not written: the stations' copies stay.
    expect(session.api.updateOperator).not.toHaveBeenCalled();
  });

  it("creates an employee from an operator in one write", async () => {
    const session = adminSession();
    session.api.createEmployee.mockResolvedValue({
      id: "0f1e2d3c-4b5a-4968-8776-655443322110",
      name: "Борис Орлов",
      role: null,
      operatorId: BORIS_OP.id,
      archived: false,
      rev: 64,
    });
    await openOperators(session);
    pressRowAction(within(rowOf("Борис Орлов")), "Сотрудник оператора «Борис Орлов»");
    chooseValue("Сотрудник", "new");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Создать сотрудника" }));
    await screen.findByText(
      "Сотрудник «Борис Орлов» добавлен и связан с оператором «Борис Орлов».",
    );
    expect(session.api.createEmployee).toHaveBeenCalledWith(expect.any(String), {
      name: "Борис Орлов",
      role: null,
      operatorId: BORIS_OP.id,
    });
  });

  it("unlinks an operator from its employee", async () => {
    const session = adminSession();
    session.api.updateEmployee.mockResolvedValue({ ...ANNA, operatorId: null, rev: 65 });
    await openOperators(session);
    pressRowAction(within(rowOf("Анна Кузнецова")), "Сотрудник оператора «Анна Кузнецова»");
    expect(
      within(dialog()).getByText(
        "Оператор 0042 · Анна Кузнецова и сотрудник «Анна Кузнецова-Смирнова» больше не будут связаны. Вход оператора на станциях не меняется.",
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отвязать" }));
    await screen.findByText("Оператор «Анна Кузнецова» отвязан от сотрудника.");
    expect(session.api.updateEmployee).toHaveBeenCalledWith(expect.any(String), ANNA.id, {
      name: "Анна Кузнецова-Смирнова",
      role: "Упаковщик",
      operatorId: null,
      archived: false,
      expectedRev: 61,
    });
  });
});
