import {
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
  type LabelTemplateSpec,
} from "@markiro/domain";
import { fireEvent, screen } from "@testing-library/react";

import type { BootstrapRequest, StockTemplate, TemplatePurpose } from "../../src/host/protocol.js";

function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function next(): void {
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
}

/**
 * Fill every step with valid answers, up to the review. The GLN has a
 * correct check digit: 4600682000013.
 */
export async function reachReview(): Promise<void> {
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
}

/** Fill every step with valid answers and press «Создать». */
export async function completeWizard(): Promise<void> {
  await reachReview();
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
}

/** One family of the domain's stock templates as the wizard sends it. */
function family(
  purpose: TemplatePurpose,
  built: readonly { name: string; spec: LabelTemplateSpec }[],
  defaultName: string | null,
): StockTemplate[] {
  return built.map(({ name, spec }) =>
    name === defaultName ? { name, purpose, spec, orgDefault: true } : { name, purpose, spec },
  );
}

/**
 * The stock templates the wizard sends, built here from the domain's
 * builders, as the cloud seeds a new tenant: the dated box 58×40 and the
 * pallet 100×150 are the organization's defaults, a duplicate has none, and
 * every other template leaves `orgDefault` out.
 */
export const EXPECTED_TEMPLATES: StockTemplate[] = [
  ...family("box", buildDefaultLabelTemplates(), DEFAULT_BOX_LABEL_TEMPLATE_NAME),
  ...family("product_duplicate", buildDuplicateLabelTemplates(), null),
  ...family("pallet", buildPalletLabelTemplates(), PALLET_LABEL_TEMPLATE_NAME),
];

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
  templates: EXPECTED_TEMPLATES,
};
