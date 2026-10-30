/* global document, getComputedStyle */
// The office instructions' states (MKR-INS-08 planning, 09 the shift's course and close,
// 10 the catalog): each opens the office on the host PC as its administrator and reaches one
// screen the way a person would.
import { ADMIN, OPERATORS } from "./site.mjs";
import { scan, shiftCard } from "./states.mjs";

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
const state = (title, steps, { boxClosed = false } = {}) => ({
  title,
  async run({ computer, shoot }) {
    // The line 1 station first closes the shift's open box (`stationClosesBox`).
    if (boxClosed) await stationClosesBox(computer);
    const opened = await office(computer);
    await steps(opened.page, opened);
    await shoot(opened.page);
  },
});

/** The menu of row `name` («Действия: …»), then its item `item`. */
async function rowMenu(page, name, item) {
  await page.getByRole("button", { name: `Действия: ${name}` }).click();
  await settle(page, 300);
  // The menu of a low row reaches past the frame: the keyboard picks its item.
  await page.getByRole("menuitem", { name: item }).focus();
  await page.keyboard.press("Enter");
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

/** A 13-digit GTIN under the seeded counterparty's GS1 prefix 4607000 (check digit 4). */
const COUNTERPARTY_GTIN = "4607000000014";
/** The seeded draft (`DRAFT_PRODUCT` of seed-office.mjs). */
const DRAFT = "Вода питьевая «Родник» негазированная 5 л";
/** The seeded product with a photo. */
const STILL05 = "Вода питьевая «Родник» негазированная 0,5 л";

/** The shift the seed's station opened and scanned into. */
const ACTIVE = "OCT26-001";
/** The reason the office gives when it closes a shift a station will not finish. */
const CLOSE_REASON = "Станция линии 1 вышла из строя, смену закрывает технолог";

/** The card of shift `number` from «Смены» (its number is the card's link). */
async function openCard(page, number) {
  await section(page, "Смены");
  await page.getByRole("link", { name: `Карточка смены ${number}` }).click();
  await page.getByRole("heading", { name: `Смена ${number}` }).waitFor();
  await settle(page, 1000);
}

/** Tab `name` of the open shift card. */
async function cardTab(page, name) {
  await page.getByRole("tab", { name }).click();
  await settle(page, 1200);
}

/** Closes the active shift from the office, as «Закрыть смену» does, and stays on «Смены». */
async function closeActive(page) {
  await section(page, "Смены");
  await rowMenu(page, ACTIVE, `Закрыть смену ${ACTIVE}`);
  await page.getByRole("dialog").getByLabel("Причина закрытия").fill(CLOSE_REASON);
  await page.getByRole("dialog").getByRole("button", { name: "Закрыть смену" }).click();
  await page.getByText(`Смена ${ACTIVE} закрыта.`).waitFor();
  await settle(page, 1000);
}

/**
 * The line 1 station closes the open box of the active shift (5 of 12), so every code of the
 * shift sits in a closed box, and leaves the shift; the office then has a shift to close and
 * export whole.
 */
async function stationClosesBox(computer) {
  const { page } = await computer("station-1", "station");
  await page.getByText("Отсканируйте бейдж").waitFor();
  await page.waitForTimeout(1500);
  await scan(page, OPERATORS[0].badge);
  await page.getByRole("heading", { name: "Смены линии" }).waitFor();
  await page.waitForTimeout(800);
  await shiftCard(page, ACTIVE).getByRole("button").first().click();
  await page.getByText("Открытый короб").waitFor();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Закрыть короб" }).click();
  // «Закрыть неполный короб? В коробе 5 из 12.» answers with its own «Закрыть короб».
  await page.getByText("Закрыть неполный короб?").waitFor();
  await page.getByRole("button", { name: "Закрыть короб" }).last().click();
  await page.getByText("Открытый короб").waitFor();
  await page
    .getByText("0 из 12")
    .or(page.getByText(/^0$/))
    .first()
    .waitFor()
    .catch(() => {});
  // The facts reach the host before the office reads them.
  await page.waitForTimeout(2500);
  return page;
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

  // MKR-INS-09: the shift's course, its close and the exports.
  "ins09/overview": state("09: обзор", async (page) => {
    await settle(page, 1200);
  }),
  "ins09/shift-totals": state("09: итоги активной смены", async (page) => {
    await section(page, "Смены");
    await page.getByRole("button", { name: `Итоги смены ${ACTIVE}` }).click();
    await settle(page, 1000);
  }),
  "ins09/card-summary": state("09: карточка активной смены", async (page) => {
    await openCard(page, ACTIVE);
  }),
  "ins09/card-boxes": state("09: короба смены", async (page) => {
    await openCard(page, ACTIVE);
    await cardTab(page, "Короба");
  }),
  "ins09/card-pallets": state("09: паллеты смены", async (page) => {
    await openCard(page, ACTIVE);
    await cardTab(page, "Паллеты");
  }),
  "ins09/card-scans": state("09: сканирования смены", async (page) => {
    await openCard(page, ACTIVE);
    await cardTab(page, "Сканирования");
  }),
  "ins09/export-active": state("09: выгрузка незакрытой смены", async (page) => {
    await section(page, "Смены");
    await rowMenu(page, ACTIVE, `Выгрузка смены ${ACTIVE}`);
    await settle(page, 1500);
  }),
  "ins09/close": state("09: закрытие смены в офисе", async (page) => {
    await section(page, "Смены");
    await rowMenu(page, ACTIVE, `Закрыть смену ${ACTIVE}`);
    await page.getByRole("dialog").getByLabel("Причина закрытия").fill(CLOSE_REASON);
    await settle(page);
  }),
  "ins09/closed-list": state(
    "09: закрытая смена в списке",
    async (page) => {
      await closeActive(page);
      await page.getByRole("combobox", { name: "Статус" }).click();
      await settle(page, 300);
      await page.getByRole("option", { name: "Закрыта" }).click();
      await settle(page, 1000);
    },
    { boxClosed: true },
  ),
  "ins09/export-open-box": state("09: выгрузка смены с открытым коробом", async (page) => {
    await closeActive(page);
    await openCard(page, ACTIVE);
    await page.getByRole("button", { name: "Выгрузка", exact: true }).click();
    await page.getByRole("button", { name: "Сформировать и сохранить" }).waitFor();
    await settle(page, 1500);
  }),
  "ins09/export-closed": state(
    "09: выгрузка закрытой смены",
    async (page) => {
      await closeActive(page);
      await openCard(page, ACTIVE);
      await page.getByRole("button", { name: "Выгрузка", exact: true }).click();
      await page.getByRole("button", { name: "Сформировать и сохранить" }).waitFor();
      await settle(page, 1500);
    },
    { boxClosed: true },
  ),
  "ins09/export-saved": state(
    "09: выгрузка сохранена",
    async (page) => {
      await closeActive(page);
      await openCard(page, ACTIVE);
      await page.getByRole("button", { name: "Выгрузка", exact: true }).click();
      await page.getByRole("radio", { name: /\[XML\]\[ГИСМТ\] Отчет об агрегации/ }).check();
      await page.getByRole("button", { name: "Сформировать и сохранить" }).click();
      await page.getByText(/Сохранено файлов/).waitFor();
      await settle(page);
    },
    { boxClosed: true },
  ),
  "ins09/card-exports": state(
    "09: вкладка «Выгрузки»",
    async (page) => {
      await closeActive(page);
      await openCard(page, ACTIVE);
      await page.getByRole("button", { name: "Выгрузка", exact: true }).click();
      await page.getByRole("radio", { name: /\[XML\]\[ГИСМТ\] Отчет об агрегации/ }).check();
      await page.getByRole("button", { name: "Сформировать и сохранить" }).click();
      await page.getByText(/Сохранено файлов/).waitFor();
      // Escape closes the export and the card; the card opens again on its exports.
      await page.keyboard.press("Escape");
      await settle(page);
      await openCard(page, ACTIVE);
      await cardTab(page, "Выгрузки");
    },
    { boxClosed: true },
  ),

  // MKR-INS-10: the products and the product card.
  "ins10/products-list": state("10: товары", async (page) => {
    await section(page, "Товары");
  }),
  "ins10/product-new": state("10: новый товар контрагента", async (page) => {
    await section(page, "Товары");
    await page.getByRole("button", { name: "Добавить товар" }).click();
    await page.getByRole("dialog").getByLabel("GTIN").fill(COUNTERPARTY_GTIN);
    await page
      .getByRole("dialog")
      .getByLabel("Название", { exact: true })
      .fill("Вода питьевая «Аква» негазированная 1 л");
    await page.getByRole("dialog").getByLabel("Название для печати").fill("Вода «Аква» 1 л");
    await settle(page);
  }),
  "ins10/product-card": state("10: карточка товара с фото", async (page) => {
    await section(page, "Товары");
    await page.getByRole("button", { name: `Изменить товар «${STILL05}»` }).click();
    await settle(page, 1200);
  }),
  "ins10/product-card-end": state("10: карточка товара, шаблоны и контрагент", async (page) => {
    await section(page, "Товары");
    await page.getByRole("button", { name: `Изменить товар «${STILL05}»` }).click();
    await settle(page, 1200);
    await panelToEnd(page);
  }),
  "ins10/product-archive": state("10: товар в архив", async (page) => {
    await section(page, "Товары");
    await rowMenu(page, STILL05, `Убрать товар «${STILL05}» в архив`);
  }),
  "ins10/product-draft": state("10: черновик товара", async (page) => {
    await section(page, "Товары");
    await page.getByRole("button", { name: `Изменить товар «${DRAFT}»` }).click();
    await settle(page, 1200);
    await page.getByText("Товар остаётся черновиком").scrollIntoViewIfNeeded();
    await settle(page);
  }),
};
