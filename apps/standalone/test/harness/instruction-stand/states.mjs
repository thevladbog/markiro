/* global window, KeyboardEvent */
// What the snapshot's station did, and the named states of the stand: each reaches one screen
// from the snapshot by the clicks and scans a person would make, then shoots it.
import { ADMIN, markingCode, OPERATORS, PRODUCTS } from "./site.mjs";
import { runWizard } from "./seed.mjs";
import { INSTALL_STATES } from "./states-install.mjs";
import { OFFICE_STATES } from "./states-office.mjs";
import { STATION_STATES } from "./states-station.mjs";

/** A HID scanner: the code's characters, GS as Ctrl+], then Enter (`createKeyboardWedgeSource`). */
export async function scan(page, code) {
  await page.evaluate((raw) => {
    const press = (init) =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
      );
    for (const char of raw) press(char === "\u001d" ? { key: "]", ctrlKey: true } : { key: char });
    press({ key: "Enter" });
  }, code);
  await page.waitForTimeout(350);
}

/** The card of shift `number` on the station's shift list. */
export const shiftCard = (page, number) => page.locator(".shift-card").filter({ hasText: number });

/** The page's text, for writing a new state (`--verbose` runs print it on failure). */
export const dump = async (page, label = "") =>
  console.log(`---- ${label}\n${(await page.locator("body").innerText()).slice(0, 3000)}`);

/** The shift the seed opened on line 1 and scanned into. */
export const ACTIVE_SHIFT = "OCT26-001";
/** Codes the seed scanned: two full boxes of 12 and five in the third. */
export const SEEDED_SCANS = 29;

/** The station's printer: one network Zebra for boxes and pallets, saved in its local database. */
async function setUpPrinter(page) {
  await page.getByRole("button", { name: "Рабочее место" }).click();
  await page.getByRole("button", { name: "Добавить принтер" }).click();
  await page.getByLabel("Название").fill("Zebra ZT230");
  await page.getByLabel("Адрес принтера").fill("192.168.10.21");
  await page.getByRole("button", { name: "Готово" }).click();
  for (const purpose of ["Этикетка короба", "Этикетка паллеты"]) {
    await page.getByRole("combobox", { name: purpose }).click();
    await page.getByRole("option", { name: /Zebra ZT230/ }).click();
  }
  await page.getByRole("button", { name: "Сохранить" }).click();
  await page.getByText("Настройки сохранены").waitFor();
  await page.getByRole("button", { name: "Назад" }).click();
}

/** The operator's badge at the station's sign-in. */
async function signInByBadge(page, operator = OPERATORS[0]) {
  await page.getByText("Отсканируйте бейдж").waitFor();
  // The sign-in reads the roster after its first sync; a badge before it is unknown.
  await page.waitForTimeout(1500);
  await scan(page, operator.badge);
  await page.getByRole("heading", { name: "Смены линии" }).waitFor();
}

/** The station's part of the seed: its printer, then shift OCT26-001 opened and scanned into. */
export async function seedStationWork({ station }) {
  const { page } = station;
  await signInByBadge(page);
  await setUpPrinter(page);
  await page.getByRole("heading", { name: "Смены линии" }).waitFor();
  await page.waitForTimeout(800);
  await shiftCard(page, ACTIVE_SHIFT).getByRole("button", { name: "Открыть" }).click();
  await page.getByText("Отсканируйте код маркировки.").waitFor();
  await page.waitForTimeout(800);
  for (let n = 1; n <= SEEDED_SCANS; n += 1) await scan(page, markingCode(PRODUCTS[0].gtin14, n));
  await page.getByText(`В коробе 5 из ${PRODUCTS[0].boxCapacity}.`).waitFor();
  // The facts reach the host before the station goes.
  await page.waitForTimeout(2500);
}

/** The office on the host's computer, which opens on «Вход в офис»: the administrator's login. */
async function openOffice(computer) {
  const { page } = computer;
  await page.getByRole("heading", { name: "Вход в офис" }).waitFor();
  await page.getByLabel("Логин").fill(ADMIN.login);
  await page.getByRole("textbox", { name: "Пароль" }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("heading", { name: "Обзор" }).waitFor();
}

/** The office's section `name` from the side menu. */
async function officeSection(page, name, heading = name) {
  await page.getByRole("link", { name }).click();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}

/**
 * name → { title, empty?, run({ computer, host, shoot }) }. `empty` states run against a host
 * that has never been set up (the wizard).
 */
export const STATES = {
  ...OFFICE_STATES,
  "install/wizard-admin": {
    title: "Первый запуск хоста, шаг 1: администратор",
    empty: true,
    async run({ computer, shoot }) {
      const { page } = await computer("host", "host");
      await runWizard(page, { stopAt: "admin" });
      await shoot(page);
    },
  },
  "install/wizard-review": {
    title: "Первый запуск хоста, шаг 6: проверка",
    empty: true,
    async run({ computer, shoot }) {
      const { page } = await computer("host", "host");
      await runWizard(page, { stopAt: "review" });
      await shoot(page);
    },
  },
  "station/sign-in": {
    title: "Станция: вход оператора",
    async run({ computer, shoot }) {
      const { page } = await computer("station-1", "station");
      await page.getByText("Отсканируйте бейдж").waitFor();
      await page.waitForTimeout(1500);
      await shoot(page);
    },
  },
  "station/shift-list": {
    title: "Станция: смены линии после входа по бейджу",
    async run({ computer, shoot }) {
      const { page } = await computer("station-1", "station");
      await signInByBadge(page);
      await shoot(page);
    },
  },
  "station/work-box-in-progress": {
    title: "Станция: работа, открытый короб 5 из 12",
    async run({ computer, shoot }) {
      const { page } = await computer("station-1", "station");
      await signInByBadge(page);
      await shiftCard(page, ACTIVE_SHIFT).getByRole("button").first().click();
      await page.getByText("Открытый короб").waitFor();
      await shoot(page);
    },
  },
  "office/overview": {
    title: "Офис: обзор",
    async run({ computer, shoot }) {
      const office = await computer("host", "host");
      await openOffice(office);
      await shoot(office.page);
    },
  },
  "office/lines": {
    title: "Офис: линии",
    async run({ computer, shoot }) {
      const office = await computer("host", "host");
      await openOffice(office);
      await officeSection(office.page, "Линии");
      await shoot(office.page);
    },
  },
  "office/shift-planning": {
    title: "Офис: планирование смены",
    async run({ computer, shoot }) {
      const office = await computer("host", "host");
      await openOffice(office);
      // From the overview the button opens «Смены»; there it opens the form.
      await office.page.getByRole("button", { name: "Запланировать смену" }).click();
      await office.page.getByRole("heading", { name: "Смены", exact: true }).waitFor();
      await office.page.getByRole("button", { name: "Запланировать смену" }).click();
      await office.page.waitForTimeout(800);
      await shoot(office.page);
    },
  },
  ...STATION_STATES,
  ...INSTALL_STATES,
};
