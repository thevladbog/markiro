import { fireEvent, screen } from "@testing-library/react";

import type { BootstrapRequest } from "../../src/host/protocol.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function next(): void {
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
}

/**
 * Fill every step with valid answers and press «Создать». The GLN has a
 * correct check digit: 4600682000013.
 */
export async function completeWizard(): Promise<void> {
  await screen.findByText("Шаг 1 из 5 · Администратор");
  type("Логин", " admin ");
  type("Имя и фамилия", " Ирина Смирнова ");
  type("Пароль", "correct horse battery");
  type("Повторите пароль", "correct horse battery");
  next();

  await screen.findByText("Шаг 2 из 5 · Организация");
  type("Название организации", " ООО «Атолл» ");
  type("ИНН", "7701234567");
  type("GLN организации", "4600682000013");
  type("Префиксы GS1", "4600682, 4607091");
  next();

  await screen.findByText("Шаг 3 из 5 · Номера SSCC");
  type("Следующий номер короба", "1500");
  type("Следующий номер паллеты", "40");
  next();

  await screen.findByText("Шаг 4 из 5 · Линии");
  fireEvent.click(screen.getByRole("button", { name: "Добавить линию" }));
  type("Линия 2", "Линия 2");
  next();

  await screen.findByText("Шаг 5 из 5 · Проверка");
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
}

/** The request `completeWizard` produces. */
export const EXPECTED_REQUEST: BootstrapRequest = {
  admin: { login: "admin", name: "Ирина Смирнова", password: "correct horse battery" },
  org: {
    name: "ООО «Атолл»",
    inn: "7701234567",
    gln: "4600682000013",
    gs1Prefixes: ["4600682", "4607091"],
    timeZone: "Europe/Moscow",
  },
  sscc: { boxNextSerial: 1500, palletNextSerial: 40 },
  lines: ["Линия 1", "Линия 2"],
};
