/* global document, HTMLElement */
// The station's states for the operator and technician instructions (MKR-INS-01…04). Each reaches
// one screen of the line 1 station from the snapshot by the clicks and scans a person would make.
// `states.mjs` spreads them into its `STATES`; the helpers it exports are used inside `run` only,
// so the two modules may import each other.
import { officeLogin } from "./seed.mjs";
import { markingCode, OPERATORS, PRODUCTS } from "./site.mjs";
import { ACTIVE_SHIFT, scan, SEEDED_SCANS, shiftCard } from "./states.mjs";

const STILL = PRODUCTS[0];

/** The line 1 station, on «Вход оператора» with the roster read. */
async function station(computer) {
  const opened = await computer("station-1", "station");
  await opened.page.getByText("Отсканируйте бейдж").waitFor();
  // The sign-in reads the roster after its first sync; a badge before it is unknown.
  await opened.page.waitForTimeout(1500);
  return opened;
}

/**
 * Nothing focused: a badge scan leaves the focus ring on the heading it lands on (a real wedge
 * scanner does the same), which the frames do not need.
 */
const blur = (page) =>
  page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

/** A badge at the sign-in, then the line's shifts. */
async function signedIn(computer, operator = OPERATORS[0]) {
  const opened = await station(computer);
  await scan(opened.page, operator.badge);
  await opened.page.getByRole("heading", { name: "Смены линии" }).waitFor();
  await opened.page.waitForTimeout(800);
  await blur(opened.page);
  return opened;
}

/** Digits on the sign-in's keypad. */
async function keypad(page, digits) {
  for (const digit of digits) {
    await page.getByRole("button", { name: digit, exact: true }).click();
  }
}

/** The work screen of shift `number` from the line's shifts. */
async function openShift(page, number = ACTIVE_SHIFT) {
  await shiftCard(page, number).getByRole("button").first().click();
  await page.getByText("Последний скан").waitFor();
  await page.waitForTimeout(800);
}

/** Signed in and at work in the seeded shift: box 3 holds five codes. */
async function atWork(computer) {
  const opened = await signedIn(computer);
  await openShift(opened.page);
  return opened;
}

/** Scans codes `from`…`to` of the still water, as the line feeds them. */
async function scanRange(page, from, to) {
  for (let n = from; n <= to; n += 1) await scan(page, markingCode(STILL.gtin14, n));
}

/** The new-shift form for the first product, scanned by one of its codes. */
async function newShiftDetails(page) {
  await page.getByRole("button", { name: "Новая смена" }).click();
  await page.getByText("Отсканируйте штрихкод товара").waitFor();
  await page.waitForTimeout(500);
  await scan(page, markingCode(STILL.gtin14, 9001));
  await page.getByText("Режим работы").waitFor();
  await page.waitForTimeout(500);
}

/** The incomplete box closed, then «Закрыть смену»: the panel with the open pallet and the reason. */
async function closePanel(page) {
  await page.getByRole("button", { name: "Закрыть короб" }).click();
  await page.getByRole("button", { name: "Закрыть короб" }).last().click();
  await page.getByText("Коробов закрыто").waitFor();
  await page.waitForTimeout(2000);
  await page.getByRole("button", { name: "Закрыть смену" }).click();
  await page
    .getByText(/Закрытие смены/)
    .first()
    .waitFor();
  await page.waitForTimeout(1000);
}

/** «Исключения» from the work screen. */
async function exceptions(page) {
  await page.getByRole("button", { name: "Исключения" }).click();
  await page.getByText("Что нужно сделать?").waitFor();
  await page.waitForTimeout(800);
}

/** The view guard ignores a press right after a change of view. */
const guarded = (page) => page.waitForTimeout(700);

/** «Рабочее место» from the line's shifts, on the tab `tab`. */
async function setup(page, tab) {
  await page.getByRole("button", { name: "Рабочее место" }).click();
  await page.getByRole("heading", { name: "Рабочее место" }).waitFor();
  if (tab !== undefined) await page.getByRole("tab", { name: tab }).click();
  // The pointer off the tabs: a hovered chosen tab loses its label's contrast.
  await page.mouse.move(640, 790);
  await page.waitForTimeout(800);
}

/** A computer of the site that has never been paired: the station's first start. */
async function unpairedStation(computer) {
  const opened = await computer("station-new", "station", { openPage: false });
  opened.shell.faults.noLocalHost = true;
  await opened.open();
  await opened.page.getByText("Служба хоста не отвечает").waitFor();
  await opened.page.waitForTimeout(800);
  return opened;
}

/** «Подключиться к хосту в сети» from the start screen of a station on its own PC. */
async function networkPairing(computer) {
  const opened = await unpairedStation(computer);
  await opened.page.getByRole("button", { name: "Подключиться к хосту в сети" }).click();
  await opened.page.getByText("Подключение к хосту в сети").waitFor();
  await opened.page.waitForTimeout(800);
  return opened;
}

export const STATION_STATES = {
  // MKR-INS-01: sign-in and the shift's start.
  "station/sign-in-pin": {
    title: "Станция: вход по табельному номеру и PIN",
    async run({ computer, shoot }) {
      const { page } = await station(computer);
      await keypad(page, OPERATORS[1].login);
      await page.getByRole("button", { name: "PIN", exact: true }).click();
      await keypad(page, OPERATORS[1].pin);
      await shoot(page);
    },
  },
  "station/sign-in-name": {
    title: "Станция: поиск оператора по имени",
    async run({ computer, shoot }) {
      const { page } = await station(computer);
      await page.getByRole("button", { name: "Найти по имени" }).click();
      await page.getByLabel("Имя оператора").fill("Пет");
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/sign-in-wrong-pin": {
    title: "Станция: неверный PIN",
    async run({ computer, shoot }) {
      const { page } = await station(computer);
      await keypad(page, OPERATORS[1].login);
      await page.getByRole("button", { name: "PIN", exact: true }).click();
      await keypad(page, "0000");
      await page.getByRole("button", { name: "Войти" }).click();
      await page.getByText("Неверный табельный номер или PIN").waitFor();
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/shift-select": {
    title: "Станция: смены линии",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await shoot(page);
    },
  },
  "station/new-shift-product": {
    title: "Станция: новая смена, выбор товара",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await page.getByRole("button", { name: "Новая смена" }).click();
      await page.getByText("Отсканируйте штрихкод товара").waitFor();
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/new-shift-details": {
    title: "Станция: новая смена, режим и паллеты",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await newShiftDetails(page);
      await shoot(page);
    },
  },
  "station/new-shift-template": {
    title: "Станция: новая смена, шаблон этикетки короба",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await newShiftDetails(page);
      await page.getByRole("button", { name: "Далее" }).click();
      await page.waitForTimeout(800);
      // The preselected template, in view: the list is longer than the screen.
      await page
        .getByRole("button", { name: "Коробка 58×40", exact: false })
        .first()
        .scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shoot(page);
    },
  },
  "station/new-shift-pallet-template": {
    title: "Станция: новая смена, шаблон этикетки паллеты",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await newShiftDetails(page);
      await page.getByRole("button", { name: "Далее" }).click();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: "Далее" }).click();
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/work-start": {
    title: "Станция: рабочий экран смены без сканов",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await openShift(page, "OCT26-003");
      await shoot(page);
    },
  },

  // MKR-INS-02: the work cycle.
  "station/work-scan-wait": {
    title: "Станция: открытый короб 5 из 12, ожидание скана",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await shoot(page);
    },
  },
  "station/scan-ok": {
    title: "Станция: код принят",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await scanRange(page, SEEDED_SCANS + 1, SEEDED_SCANS + 1);
      await page.getByText(`В коробе 6 из ${STILL.boxCapacity}.`).waitFor();
      await shoot(page);
    },
  },
  "station/scan-duplicate": {
    title: "Станция: дубль",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await scanRange(page, SEEDED_SCANS, SEEDED_SCANS);
      await page.getByText("Дубль").first().waitFor();
      await shoot(page);
    },
  },
  "station/scan-wrong-product": {
    title: "Станция: чужой товар",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await scan(page, markingCode(PRODUCTS[1].gtin14, 1));
      await page.getByText("Чужой товар").first().waitFor();
      await shoot(page);
    },
  },
  "station/scan-invalid": {
    title: "Станция: неверный код",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await scan(page, "4601234567015");
      await page.getByText("НЕВЕРНЫЙ КОД").first().waitFor();
      await shoot(page);
    },
  },
  "station/box-closed": {
    title: "Станция: короб заполнен и закрыт, этикетка ушла на принтер",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await scanRange(page, SEEDED_SCANS + 1, SEEDED_SCANS + 7);
      await page.getByText("Коробов закрыто").waitFor();
      await page.waitForTimeout(1500);
      await shoot(page);
    },
  },
  "station/box-close-confirm": {
    title: "Станция: закрыть неполный короб?",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await page.getByRole("button", { name: "Закрыть короб" }).click();
      await page.getByText("Закрыть неполный короб?").waitFor();
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/print-check": {
    title: "Станция: проверка этикетки короба сканом",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await setup(page, "Принтеры");
      await page.getByRole("switch", { name: "Проверять этикетку короба" }).click();
      await page.getByRole("button", { name: "Сохранить" }).click();
      await page.getByText("Настройки сохранены").waitFor();
      await page.getByRole("button", { name: "Назад" }).click();
      await page.getByRole("heading", { name: "Смены линии" }).waitFor();
      await openShift(page);
      await scanRange(page, SEEDED_SCANS + 1, SEEDED_SCANS + 7);
      await page.getByText("Проверьте этикетку").waitFor();
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/pallet-close-confirm": {
    title: "Станция: закрыть паллету досрочно?",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await page.getByRole("button", { name: "Закрыть паллету досрочно" }).click();
      await page.getByText("Закрыть паллету досрочно?").waitFor();
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/scan-history": {
    title: "Станция: вся история сканирований",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await page.getByRole("button", { name: "Вся история" }).click();
      await page.waitForTimeout(1000);
      await shoot(page);
    },
  },
  "station/offline": {
    title: "Станция: нет связи с хостом, работа продолжается",
    async run({ host, computer, shoot }) {
      const { page } = await atWork(computer);
      await host.stop();
      await scanRange(page, SEEDED_SCANS + 1, SEEDED_SCANS + 2);
      await page
        .getByText(/Очередь \d/)
        .first()
        .waitFor({ timeout: 60_000 });
      await page.waitForTimeout(2500);
      await shoot(page);
    },
  },
  "station/sync-panel": {
    title: "Станция: синхронизация — связь, справочники, запас SSCC, очередь",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await page.getByRole("button", { name: /^Синхронизация/ }).click();
      await page.getByText("Запас номеров SSCC").waitFor();
      await page.mouse.move(640, 790);
      await page.waitForTimeout(1200);
      await shoot(page);
    },
  },
  "station/queue": {
    title: "Станция: очередь отправки",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await page.getByRole("button", { name: /Очередь отправки/ }).click();
      await page.waitForTimeout(1200);
      await shoot(page);
    },
  },
  "station/leave-shift": {
    title: "Станция: выход из смены",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await page.getByRole("button", { name: "Выйти из смены" }).click();
      await page.waitForTimeout(1200);
      await shoot(page);
    },
  },
  "station/close-blocked": {
    title: "Станция: смену пока не закрыть — открытый короб",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await page.getByRole("button", { name: "Закрыть смену" }).click();
      await page.getByText("Смену пока не закрыть").waitFor();
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/close-shift": {
    title: "Станция: закрытие смены с паллетой и причиной",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await closePanel(page);
      await shoot(page);
    },
  },
  "station/close-done": {
    title: "Станция: смена закрыта на этой станции",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await closePanel(page);
      await page.getByRole("button", { name: "Недостаток сырья" }).click();
      await page.getByRole("button", { name: "Закрыть паллету и смену" }).click();
      await page
        .getByText(/закрыта на этой станции/)
        .first()
        .waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1500);
      await shoot(page);
    },
  },
  "station/queue-waiting": {
    title: "Станция: очередь отправки без связи с хостом",
    async run({ host, computer, shoot }) {
      const { page } = await atWork(computer);
      await host.stop();
      await scanRange(page, SEEDED_SCANS + 1, SEEDED_SCANS + 2);
      await page.getByRole("button", { name: "Выйти из смены" }).click();
      await page.getByRole("heading", { name: "Смены линии" }).waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: /Очередь отправки/ }).click();
      await page.waitForTimeout(2500);
      await shoot(page);
    },
  },

  // MKR-INS-03: exceptions and recovery.
  "station/exceptions": {
    title: "Станция: исключения — что нужно сделать",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await exceptions(page);
      await shoot(page);
    },
  },
  "station/exception-target": {
    title: "Станция: исключение — выбор короба",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await exceptions(page);
      await page.getByRole("button", { name: "Перепечатать этикетку" }).first().click();
      await guarded(page);
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/exception-reason": {
    title: "Станция: исключение — причина",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await exceptions(page);
      await page.getByRole("button", { name: "Перепечатать этикетку" }).first().click();
      await guarded(page);
      await page
        .getByRole("button", { name: /^\(00\)|· 12 шт\./ })
        .first()
        .click();
      await guarded(page);
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/exception-confirm": {
    title: "Станция: исключение — подтверждение расформирования",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await exceptions(page);
      await page.getByRole("button", { name: "Расформировать короб" }).first().click();
      await guarded(page);
      await page
        .getByRole("button", { name: /· 12 шт\./ })
        .first()
        .click();
      await guarded(page);
      await page.getByRole("button", { name: "Повреждена упаковка" }).click();
      await guarded(page);
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/exception-result": {
    title: "Станция: исключение выполнено",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await exceptions(page);
      await page.getByRole("button", { name: "Перепечатать этикетку" }).first().click();
      await guarded(page);
      await page
        .getByRole("button", { name: /· 12 шт\./ })
        .first()
        .click();
      await guarded(page);
      await page.getByRole("button", { name: "Этикетка повреждена" }).click();
      await guarded(page);
      await page.getByRole("button", { name: "Перепечатать", exact: true }).click();
      await page.getByText("Этикетка отправлена на принтер.").waitFor();
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/exception-clear": {
    title: "Станция: очистить открытый короб?",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      await page.getByRole("button", { name: "Очистить короб" }).click();
      await page.getByText("Очистить короб?").waitFor();
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/pallet-exceptions": {
    title: "Станция: исключения с паллетой — выбор паллеты",
    async run({ computer, shoot }) {
      const { page } = await atWork(computer);
      // A closed pallet first: the pallet's two boxes, closed early.
      await page.getByRole("button", { name: "Закрыть паллету досрочно" }).click();
      await page.getByRole("button", { name: "Закрыть паллету", exact: true }).click();
      await page.waitForTimeout(2500);
      await exceptions(page);
      await page.getByRole("button", { name: "Расформировать паллету" }).first().click();
      await guarded(page);
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/print-failed": {
    title: "Станция: этикетка короба не напечатана",
    async run({ computer, shoot }) {
      const opened = await atWork(computer);
      opened.shell.faults.print = "not_sent";
      await scanRange(opened.page, SEEDED_SCANS + 1, SEEDED_SCANS + 7);
      await opened.page.getByText("Этикетка короба не напечатана").waitFor();
      await opened.page.waitForTimeout(800);
      await shoot(opened.page);
    },
  },
  "station/print-unknown": {
    title: "Станция: неизвестно, напечаталась ли этикетка",
    async run({ computer, shoot }) {
      const opened = await atWork(computer);
      opened.shell.faults.print = "outcome_unknown";
      await scanRange(opened.page, SEEDED_SCANS + 1, SEEDED_SCANS + 7);
      await opened.page.getByText("Неизвестно, напечаталась ли этикетка").waitFor();
      await opened.page.waitForTimeout(800);
      await shoot(opened.page);
    },
  },
  "station/reprint-setup": {
    title: "Станция: повторная печать этикеток — подготовка сеанса",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await page.getByRole("button", { name: "Повторная печать этикеток" }).click();
      await page.getByText("Подготовьте сеанс перепечатки").waitFor();
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/reprint-session": {
    title: "Станция: повторная печать — найден короб",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await page.getByRole("button", { name: "Повторная печать этикеток" }).click();
      await page.getByText("Подготовьте сеанс перепечатки").waitFor();
      await page.waitForTimeout(800);
      await page.getByRole("radio", { name: "Повреждена" }).click();
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: "Начать перепечатку" }).click();
      await page.getByText("Отсканируйте код", { exact: true }).waitFor();
      await page.waitForTimeout(800);
      await scan(page, "00046012345600000016");
      await page.waitForTimeout(2000);
      await shoot(page);
    },
  },

  // MKR-INS-04: pairing and the workstation's setup.
  "station/pairing": {
    title: "Станция: первый запуск на своём ПК — хоста на этом компьютере нет",
    async run({ computer, shoot }) {
      const { page } = await unpairedStation(computer);
      await shoot(page);
    },
  },
  "station/pairing-network": {
    title: "Станция: подключение к хосту в сети — код с экрана офиса",
    async run({ computer, shoot }) {
      const { page } = await networkPairing(computer);
      await shoot(page);
    },
  },
  "station/pairing-manual": {
    title: "Станция: подключение — адрес и код вручную",
    async run({ computer, shoot }) {
      const host = await computer("host", "host", { openPage: false });
      const token = await officeLogin(host.shell);
      const answer = await host.shell.request("POST", "/v1/office/pairing-codes", {}, token);
      const { page } = await networkPairing(computer);
      await page.getByRole("button", { name: "Ввести адрес и код вручную" }).click();
      await page.getByLabel("Адрес хоста").fill("192.168.10.5");
      await page.getByLabel("Код подключения").fill(answer.body.code);
      await page.getByLabel("Имя устройства").fill("Станция линии 2");
      await page.waitForTimeout(500);
      await shoot(page);
    },
  },
  "station/pairing-fingerprint": {
    title: "Станция: подключение — сверка отпечатка хоста",
    async run({ computer, shoot }) {
      const host = await computer("host", "host", { openPage: false });
      const token = await officeLogin(host.shell);
      const answer = await host.shell.request("POST", "/v1/office/pairing-codes", {}, token);
      const { page } = await networkPairing(computer);
      await page.getByRole("button", { name: "Ввести адрес и код вручную" }).click();
      await page.getByLabel("Адрес хоста").fill("192.168.10.5");
      await page.getByLabel("Код подключения").fill(answer.body.code);
      await page.getByLabel("Имя устройства").fill("Станция линии 2");
      await page.getByRole("button", { name: "Далее" }).click();
      await page.getByText("Отпечаток хоста").first().waitFor();
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/line-select": {
    title: "Станция: выбор линии после подключения",
    async run({ computer, shoot }) {
      const host = await computer("host", "host", { openPage: false });
      const token = await officeLogin(host.shell);
      const answer = await host.shell.request("POST", "/v1/office/pairing-codes", {}, token);
      const { page } = await networkPairing(computer);
      await page.getByRole("button", { name: "Ввести адрес и код вручную" }).click();
      await page.getByLabel("Адрес хоста").fill("192.168.10.5");
      await page.getByLabel("Код подключения").fill(answer.body.code);
      await page.getByLabel("Имя устройства").fill("Станция линии 2");
      await page.getByRole("button", { name: "Далее" }).click();
      await page.getByRole("button", { name: "Отпечаток совпадает" }).click();
      await page.getByText("Выберите линию, на которой работает эта станция.").waitFor();
      await page.waitForTimeout(1500);
      await shoot(page);
    },
  },
  "station/setup-printers": {
    title: "Станция: рабочее место — принтеры",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await setup(page, "Принтеры");
      await shoot(page);
    },
  },
  "station/setup-printer-form": {
    title: "Станция: рабочее место — новый сетевой принтер",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await setup(page, "Принтеры");
      await page.getByRole("button", { name: "Добавить принтер" }).click();
      await page.getByLabel("Название").fill("TSC TE210");
      await page.getByLabel("Адрес принтера").fill("192.168.10.22");
      await page.waitForTimeout(800);
      await shoot(page);
    },
  },
  "station/setup-scanners": {
    title: "Станция: рабочее место — сканеры",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await setup(page, "Сканеры");
      await shoot(page);
    },
  },
  "station/setup-sound": {
    title: "Станция: рабочее место — звук",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await setup(page, "Звук");
      await shoot(page);
    },
  },
  "station/setup-station": {
    title: "Станция: рабочее место — станция (версия и отвязка)",
    async run({ computer, shoot }) {
      const { page } = await signedIn(computer);
      await setup(page, "Станция");
      await shoot(page);
    },
  },
};
