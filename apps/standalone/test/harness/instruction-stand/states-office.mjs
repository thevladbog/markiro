/* global document, getComputedStyle */
// The office instructions' states (MKR-INS-08 planning, 09 the shift's course and close,
// 10 the catalog): each opens the office on the host PC as its administrator and reaches one
// screen the way a person would.
import { ADMIN } from "./site.mjs";

/** The office on the host PC: the administrator's login, then «Обзор». */
async function office(computer) {
  const opened = await computer("host", "host");
  const { page } = opened;
  await page.getByRole("heading", { name: "Вход в офис" }).waitFor();
  await page.getByLabel("Логин").fill(ADMIN.login);
  await page.getByRole("textbox", { name: "Пароль" }).fill(ADMIN.password);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("heading", { name: "Обзор" }).waitFor();
  return opened;
}

/** The section `name` from the side menu. */
async function section(page, name, heading = name) {
  await page
    .getByRole("navigation", { name: "Разделы офиса" })
    .getByRole("link", { name, exact: true })
    .click();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
  await page.waitForTimeout(600);
}

const settle = (page, ms = 700) => page.waitForTimeout(ms);

/** One state: open the office, run `steps`, shoot. */
const state = (title, steps) => ({
  title,
  async run({ computer, shoot }) {
    const opened = await office(computer);
    await steps(opened.page, opened);
    await shoot(opened.page);
  },
});

/** The menu of row `name` («Действия: …»), then its item `item`. */
async function rowMenu(page, name, item) {
  await page.getByRole("button", { name: `Действия: ${name}` }).click();
  await settle(page, 300);
  await page.getByRole("menuitem", { name: item }).click();
  await settle(page);
}

/** A select (combobox) `label` of the open dialog, then its option matching `option`. */
async function choose(page, label, option) {
  await page.getByRole("dialog").getByRole("combobox", { name: label }).click();
  await settle(page, 300);
  await page.getByRole("option", { name: option }).first().click();
  await settle(page, 300);
}

/** «Новая смена» from «Смены». */
async function newShift(page) {
  await section(page, "Смены");
  await page.getByRole("button", { name: "Запланировать смену" }).click();
  await page.getByRole("heading", { name: "Новая смена" }).waitFor();
  await settle(page);
}

/** Scrolls the open side panel's body to its end. */
async function panelToEnd(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) {
      const style = getComputedStyle(element);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 4 &&
        element.closest("[role=dialog]")
      )
        element.scrollTop = element.scrollHeight;
    }
  });
  await settle(page);
}

export const OFFICE_STATES = {
  // MKR-INS-08: lines, devices, planning.
  "ins08/lines-list": state("08: линии", async (page) => {
    await section(page, "Линии");
  }),
  "ins08/line-form": state("08: новая линия", async (page) => {
    await section(page, "Линии");
    await page.getByRole("button", { name: "Добавить линию" }).click();
    await page.getByRole("dialog").getByLabel("Название линии").fill("Линия фасовки 5 л");
    await settle(page);
  }),
  "ins08/line-edit": state("08: линия, максимум станций", async (page) => {
    await section(page, "Линии");
    await page.getByRole("button", { name: "Переименовать линию «Линия розлива 1»" }).click();
    await settle(page);
  }),
  "ins08/devices-list": state("08: устройства", async (page) => {
    await section(page, "Устройства");
  }),
  "ins08/device-line": state("08: линия устройства", async (page) => {
    await section(page, "Устройства");
    await page.getByRole("button", { name: "Изменить устройство «Станция линии 1»" }).click();
    await settle(page);
  }),
  "ins08/shifts-list": state("08: смены", async (page) => {
    await section(page, "Смены");
  }),
  "ins08/shift-new": state("08: новая смена, товар выбран", async (page) => {
    await newShift(page);
    await choose(page, "Товар", /негаз\. 0,5 л/);
    await choose(page, "Линия", "Линия розлива 1");
    await page.getByRole("dialog").getByLabel("План, шт").fill("2400");
    await settle(page);
  }),
  "ins08/shift-new-pallets": state("08: новая смена, агрегация и паллеты", async (page) => {
    await newShift(page);
    await choose(page, "Товар", /негаз\. 0,5 л/);
    await choose(page, "Линия", "Линия розлива 1");
    await page.getByRole("dialog").getByLabel("План, шт").fill("2400");
    await page.getByRole("dialog").getByLabel("С паллетами").check();
    await panelToEnd(page);
  }),
  "ins08/shift-new-duplicate": state("08: новая смена, проверка с дубликатом", async (page) => {
    await newShift(page);
    await choose(page, "Товар", / газ\. 1,5 л/);
    await page.getByRole("dialog").getByLabel("Проверка").check();
    await page.getByRole("dialog").getByLabel("Печатать дубликат Data Matrix").check();
    await choose(page, "Линия", "Линия розлива 2");
    await choose(page, "Шаблон этикетки продукции", /мм/);
    await page.getByRole("dialog").getByLabel("Обязательная проверка этикетки").check();
    await panelToEnd(page);
  }),
  "ins08/shift-planned-card": state("08: карточка запланированной смены", async (page) => {
    await section(page, "Смены");
    await page.getByRole("button", { name: "Открыть смену OCT26-003" }).click();
    await page.getByRole("heading", { name: "Смена OCT26-003" }).waitFor();
    await settle(page);
  }),
  "ins08/shift-planned-edit": state("08: изменение запланированной смены", async (page) => {
    await section(page, "Смены");
    await page.getByRole("button", { name: "Открыть смену OCT26-003" }).click();
    await page.getByRole("button", { name: "Изменить смену OCT26-003" }).click();
    await settle(page);
  }),
  "ins08/shift-active-plan": state("08: план активной смены", async (page) => {
    await section(page, "Смены");
    await rowMenu(page, "OCT26-001", "Изменить план смены OCT26-001");
  }),
  "ins08/shift-delete": state("08: удаление смены", async (page) => {
    await section(page, "Смены");
    await rowMenu(page, "OCT26-003", "Удалить смену OCT26-003");
  }),
};
