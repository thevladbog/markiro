import { boxLabelFields, palletLabelFields } from "@markiro/domain";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  FinishDialog,
  JobView,
  ManualView,
  ReasonDialog,
  SessionView,
  SetupView,
  type JobHandlers,
} from "../src/floor/warehouse/ReprintViews.js";
import type { SummaryLine } from "../src/floor/warehouse/ReprintParts.js";
import type { WarehouseJob } from "../src/floor/warehouse/warehouse-store.js";
import { summaryRows } from "../src/floor/warehouse/warehouse-view.js";
import { OPERATOR_ID } from "./support/floor-work.js";
import { HP_A4, TSC, ZEBRA } from "./support/printing.js";
import { BOX_SSCC, KM, PALLET_SSCC } from "./support/warehouse.js";

/**
 * Every state of the reprint's views on its own (design: station reprint, 2026-10): the words, the
 * roles and the answers each one offers, without a database. The screen's logic is tested
 * through the real screen (warehouse-screen*.test.tsx); here only what is on the glass.
 */

const FIELDS = boxLabelFields({
  sscc: BOX_SSCC,
  itemCount: 24,
  productName: "Сидр полусухой «Дикий крест» 0,45 л",
  productPrintName: "Сидр «Дикий крест» 0,45 л",
  gtin14: "04600682000013",
  egaisCode: null,
  shelfLifeDays: 365,
  operatorName: "Анна Кузнецова",
  counterpartyName: "ООО «Северный берег»",
  closedAt: "2026-10-17T11:29:00.000Z",
  productionDate: "2026-10-17",
  shiftNumber: "ОКТ26-004",
});

function job(over: Partial<WarehouseJob> = {}): WarehouseJob {
  return {
    id: "job-1",
    sessionId: "s",
    kind: "box",
    subjectId: "subject",
    identity: BOX_SSCC,
    repair: null,
    reason: "damaged",
    state: "sent",
    templateId: "t",
    templateRev: 1,
    templateSpec: "{}",
    fields: FIELDS,
    printer: ZEBRA,
    bytesBase64: "XlhB",
    errorCode: null,
    attempts: 1,
    operatorId: OPERATOR_ID,
    createdAt: "2026-10-17T11:32:00.000Z",
    updatedAt: "2026-10-17T11:32:00.000Z",
    ...over,
  };
}
const unit = (over: Partial<WarehouseJob> = {}) =>
  job({
    kind: "unit",
    identity: "hash",
    fields: { ...FIELDS, "km.code": KM },
    printer: TSC,
    ...over,
  });
const pallet = (over: Partial<WarehouseJob> = {}) =>
  job({
    kind: "pallet",
    identity: PALLET_SSCC,
    fields: palletLabelFields({
      sscc: PALLET_SSCC,
      boxCount: 18,
      itemCount: 432,
      productName: "Сидр",
      productPrintName: null,
      gtin14: "04600682000013",
      egaisCode: null,
      shelfLifeDays: 365,
      operatorName: null,
      counterpartyName: null,
      closedAt: "2026-10-17T11:29:00.000Z",
      productionDate: "2026-10-17",
      shiftNumber: null,
    }),
    ...over,
  });

const press = (action: () => void) => ({ onClick: action });
const handlers = (): JobHandlers => ({
  onSend: vi.fn(),
  onRetry: vi.fn(),
  onCancelJob: vi.fn(),
  onAgain: vi.fn(),
  onNext: vi.fn(),
  onVerify: vi.fn(),
  onSetup: vi.fn(),
  onLeave: vi.fn(),
});
const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);
const buttonNames = () => screen.getAllByRole("button").map((button) => button.textContent?.trim());

afterEach(cleanup);

function jobView(shown: WarehouseJob, over: Partial<React.ComponentProps<typeof JobView>> = {}) {
  const h = handlers();
  wrap(
    <JobView
      job={shown}
      verifying={false}
      templateName="Короб 100×150"
      resultText={null}
      note={null}
      said={null}
      online
      scanner="connected"
      reasonText="Причина: Повреждена"
      press={press}
      leave={press}
      handlers={h}
      {...over}
    />,
  );
  return h;
}

describe("the job's detail", () => {
  it("shows a box by its grouped SSCC, product, facts, template, printer and reason", () => {
    jobView(job());
    expect(screen.getByLabelText("Короб")).toBeTruthy();
    expect(screen.getByText("04 6006 8200 0001 5000")).toBeTruthy();
    expect(screen.getByText("Сидр «Дикий крест» 0,45 л")).toBeTruthy();
    expect(screen.getByText("Количество").nextElementSibling?.textContent).toBe("24");
    expect(screen.getByText("Короб 100×150")).toBeTruthy();
    expect(screen.getByText(ZEBRA.name)).toBeTruthy();
    expect(screen.getByText("Готов")).toBeTruthy();
    expect(screen.getByText("Повреждена")).toBeTruthy();
    // No copies control: several labels are separate attempts, each with its own reason.
    expect(screen.queryByText("Копий")).toBeNull();
  });

  it("leads a unit with its serial and puts the GTIN beside it", () => {
    jobView(unit(), { templateName: "Дубликат Data Matrix 40×30" });
    expect(screen.getByLabelText("Единица · дубликат Data Matrix")).toBeTruthy();
    expect(screen.getByText("Серийный номер")).toBeTruthy();
    expect(screen.getByText("S000001")).toBeTruthy();
    expect(screen.getByText("GTIN 04600682000013")).toBeTruthy();
  });

  it("counts a pallet's boxes first", () => {
    jobView(pallet(), { templateName: "Паллета 100×150" });
    expect(screen.getByLabelText("Паллета")).toBeTruthy();
    const facts = screen.getAllByText(/^(Коробов|Количество|Дата производства)$/);
    expect(facts[0]?.textContent).toBe("Коробов");
    expect(screen.getByText("Коробов").nextElementSibling?.textContent).toBe("18");
  });

  it("offers the print of a prepared job, and nothing else", () => {
    const h = jobView(job({ state: "prepared" }));
    expect(screen.getByText("Этикетка готова к отправке")).toBeTruthy();
    expect(buttonNames()).toEqual(["К сменам", "Напечатать этикетку"]);
    fireEvent.click(screen.getByRole("button", { name: "Напечатать этикетку" }));
    expect(h.onSend).toHaveBeenCalledTimes(1);
  });

  it("says a send in hand with a still glyph, and offers no second print", () => {
    jobView(job({ state: "sending" }), {
      resultText: "Не закрывайте экран: результат появится здесь.",
    });
    expect(screen.getByText("Передаём этикетку на принтер…")).toBeTruthy();
    expect(screen.getByText("Принимает задание")).toBeTruthy();
    const printing = screen.getByRole("button", { name: "Печатаем…" });
    expect(printing.getAttribute("aria-disabled")).toBe("true");
    expect(document.querySelector("animate, [class*='spin']")).toBeNull();
  });

  it("says «Это не подтверждает выход этикетки» of a label sent, and offers the next code first", () => {
    const h = jobView(job(), {
      resultText: "Это не подтверждает выход этикетки. Можно сканировать следующий код.",
    });
    expect(screen.getByText("Этикетка передана на принтер")).toBeTruthy();
    expect(screen.getByText(/Это не подтверждает выход этикетки/)).toBeTruthy();
    expect(buttonNames()).toEqual(["К сменам", "Напечатать ещё раз", "Следующий код"]);
    // The check by a scan is the unknown outcome's alone: the code does not offer it for a sent label.
    expect(screen.queryByRole("button", { name: "Проверить сканом" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Следующий код" }));
    expect(h.onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Напечатать ещё раз" }));
    expect(h.onAgain).toHaveBeenCalledTimes(1);
  });

  it("makes the check by a scan the main answer of an unknown outcome, never the repeat", () => {
    const h = jobView(job({ state: "unknown", errorCode: "outcome_unknown" }), {
      resultText: "Проверьте принтер.",
    });
    expect(screen.getByText("Неизвестно, вышла ли этикетка")).toBeTruthy();
    expect(buttonNames()).toEqual(["К сменам", "Напечатать ещё раз", "Проверить сканом"]);
    const verify = screen.getByRole("button", { name: "Проверить сканом" });
    expect(verify.className).toContain("floor-primary");
    fireEvent.click(verify);
    expect(h.onVerify).toHaveBeenCalledTimes(1);
  });

  it("waits for a scan of the new label while it is checked, and can be cancelled", () => {
    jobView(job({ state: "unknown", errorCode: "outcome_unknown" }), {
      verifying: true,
      resultText: "Скан старой этикетки с «!1» новую печать не подтверждает.",
    });
    expect(screen.getByText("Отсканируйте новую этикетку")).toBeTruthy();
    const cancel = screen.getByRole("button", { name: "Отменить проверку" });
    expect(cancel.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps the retry for a printer's error, with the workstation and the cancel beside it", () => {
    const h = jobView(job({ state: "failed", errorCode: "not_sent" }), {
      resultText: "Ничего не напечатано.",
    });
    expect(screen.getByText("Этикетка не отправлена")).toBeTruthy();
    expect(screen.getByText("Принтер: ошибка")).toBeTruthy();
    expect(buttonNames()).toEqual([
      "К сменам",
      "Отменить печать",
      "Рабочее место",
      "Повторить отправку",
    ]);
    expect(screen.getByRole("button", { name: "Повторить отправку" }).className).toContain(
      "floor-primary",
    );
    fireEvent.click(screen.getByRole("button", { name: "Отменить печать" }));
    expect(h.onCancelJob).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Рабочее место" }));
    expect(h.onSetup).toHaveBeenCalledTimes(1);
  });

  it("makes the workstation the main answer when it is the printer that is missing", () => {
    jobView(pallet({ state: "failed", errorCode: "printer_a4", printer: null }), {
      resultText: "Принтер паллет печатает листы А4, а это задание — термоэтикетка.",
    });
    expect(screen.getByText("Принтер паллет печатает листы А4")).toBeTruthy();
    expect(screen.getAllByText("Не назначен").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Рабочее место" }).className).toContain(
      "floor-primary",
    );
    expect(screen.getByRole("button", { name: "Повторить отправку" }).className).not.toContain(
      "floor-primary",
    );
  });

  it("closes a cancelled job on the next code, and a checked one beside the repeat", () => {
    jobView(job({ state: "cancelled" }));
    expect(screen.getByText("Печать отменена")).toBeTruthy();
    expect(buttonNames()).toEqual(["К сменам", "Следующий код"]);
    cleanup();
    jobView(job({ state: "verified" }));
    expect(screen.getByText("Новая этикетка проверена")).toBeTruthy();
    expect(buttonNames()).toEqual(["К сменам", "Напечатать ещё раз", "Следующий код"]);
  });

  it("keeps the leave in the heading in every state, beside the reason in words", () => {
    const h = jobView(job({ state: "unknown", errorCode: "outcome_unknown" }));
    expect(screen.getByText("Причина: Повреждена")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    expect(h.onLeave).toHaveBeenCalledTimes(1);
  });

  it("says the old label that was made anew, and a banner above the zones", () => {
    jobView(job(), {
      note: "Распознана старая этикетка с «!1»: новая — с тем же SSCC без ошибки.",
      said: { tone: "warn", text: "Этот код уже печатали в этом сеансе.", kind: "duplicate" },
    });
    expect(screen.getByText(/Распознана старая этикетка/)).toBeTruthy();
    expect(screen.getByText("Код уже в журнале сеанса")).toBeTruthy();
  });
});

function sessionView(over: Partial<React.ComponentProps<typeof SessionView>> = {}) {
  const calls = {
    onOpen: vi.fn(),
    onReason: vi.fn(),
    onManual: vi.fn(),
    onTemplates: vi.fn(),
    onFinish: vi.fn(),
    onLeave: vi.fn(),
    onFilter: vi.fn(),
  };
  wrap(
    <SessionView
      journal={[]}
      filter="all"
      said={null}
      online
      scanner="connected"
      reasonText="Причина: Повреждена"
      sent={3}
      press={press}
      leave={press}
      {...calls}
      {...over}
    />,
  );
  return calls;
}

describe("the session's view", () => {
  it("says an empty journal and waits for a scan, with the scanner ready and the typed code beside it", () => {
    const calls = sessionView();
    expect(screen.getByText("В этом сеансе ничего не напечатано")).toBeTruthy();
    expect(screen.getByText("Отсканируйте код")).toBeTruthy();
    expect(screen.getByText("Сканер готов")).toBeTruthy();
    expect(screen.getByText("Передано на принтер: 3")).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "Показать" })).toBeNull();
    expect(buttonNames()).toEqual([
      "Причина: Повреждена",
      "Ввести код вручную",
      "К сменам",
      "Шаблоны",
      "Завершить сеанс",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Ввести код вручную" }));
    expect(calls.onManual).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Причина: Повреждена" }));
    expect(calls.onReason).toHaveBeenCalledTimes(1);
  });

  const JOURNAL = [
    unit({ id: "u", updatedAt: "2026-10-17T11:32:00.000Z" }),
    job({ id: "b", state: "verified" }),
    pallet({ id: "p", state: "unknown", errorCode: "outcome_unknown" }),
    pallet({ id: "s", printer: HP_A4 }),
    job({ id: "f", state: "failed", errorCode: "not_sent", identity: "046006820000015017" }),
  ];

  it("lists the journal's rows with a glyph, the code, the product, a tag in words and the time", () => {
    const calls = sessionView({ journal: JOURNAL });
    const rows = within(screen.getByRole("region", { name: "Журнал сеанса" })).getAllByRole(
      "button",
      { name: /^Открыть:/ },
    );
    expect(rows).toHaveLength(5);
    expect(rows[0]?.textContent).toContain("S000001");
    expect(rows[0]?.textContent).toContain("Единица · Сидр «Дикий крест» 0,45 л");
    expect(rows[0]?.textContent).toContain("Передано");
    expect(rows[1]?.textContent).toContain("Проверено");
    expect(rows[2]?.textContent).toContain("Неизвестно");
    expect(rows[2]?.textContent).toContain("18 кор.");
    expect(rows[3]?.textContent).toContain("Лист А4");
    expect(rows[4]?.textContent).toContain("Не отправлено");
    // A row opens its job.
    fireEvent.click(rows[2] as HTMLElement);
    expect(calls.onOpen).toHaveBeenCalledWith(JOURNAL[2]);
  });

  it("filters the journal by kind with a segment of five, and says when a kind has nothing", () => {
    const calls = sessionView({ journal: JOURNAL, filter: "sheet" });
    const group = screen.getByRole("radiogroup", { name: "Показать" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Все", "Короба", "Паллеты", "Единицы", "Листы А4"]);
    expect(
      within(group).getByRole("radio", { name: "Листы А4" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getAllByRole("button", { name: /^Открыть:/ })).toHaveLength(1);
    fireEvent.click(within(group).getByRole("radio", { name: "Паллеты" }));
    expect(calls.onFilter).toHaveBeenCalledWith("pallet");
    cleanup();
    sessionView({ journal: [job({ id: "only" })], filter: "unit" });
    expect(screen.getByText("В этом виде пока ничего нет.")).toBeTruthy();
  });

  it("says a code not found above the zones and on the zone, and keeps the typed code open", () => {
    sessionView({
      journal: JOURNAL,
      said: {
        tone: "warn",
        text: "Код не найден в базе хоста. Проверьте этикетку.",
        kind: "not_found",
      },
    });
    expect(screen.getByText("Код не найден", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Не найдено")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ввести код вручную" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("says that nothing can be searched without the link, and shuts the typed code", () => {
    sessionView({ journal: JOURNAL, online: false });
    expect(screen.getByText("Нет связи с хостом: найти код нельзя")).toBeTruthy();
    expect(screen.getByText("Поиск недоступен")).toBeTruthy();
    expect(screen.getByText("Связи нет")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Ввести код вручную" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("makes the typed code the main way in when the scanner is away", () => {
    sessionView({ journal: JOURNAL, scanner: "disconnected" });
    expect(screen.getByText("Сканер не на связи", { selector: "strong" })).toBeTruthy();
    expect(screen.getByText("Сканер не отвечает")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ввести код вручную" }).className).toContain(
      "mk-btn--primary",
    );
  });
});

describe("the start of a session", () => {
  const lines = (assignments: {
    box: string | null;
    pallet: string | null;
    duplicate: string | null;
  }): SummaryLine[] =>
    summaryRows({ printers: [ZEBRA, TSC, HP_A4], assignments }).map((row) => ({
      row,
      detail: `${row.kind}: ${row.printer?.name ?? "нет принтера"}`,
    }));

  function setup(
    reason: "damaged" | null,
    assignments: { box: string | null; pallet: string | null; duplicate: string | null } = {
      box: "zebra",
      pallet: "hp-a4",
      duplicate: "tsc",
    },
  ) {
    const calls = {
      onPick: vi.fn(),
      onChangeTemplates: vi.fn(),
      onLeave: vi.fn(),
      onSetup: vi.fn(),
      onStart: vi.fn(),
    };
    wrap(
      <SetupView
        reason={reason}
        lines={lines(assignments)}
        press={press}
        leave={press}
        {...calls}
      />,
    );
    return calls;
  }

  it("asks the reason first, as three rows of a radio group, the chosen one ticked", () => {
    const calls = setup("damaged");
    const group = screen.getByRole("radiogroup", { name: "Причина перепечатки" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Не напечаталась", "Повреждена", "Утеряна"]);
    expect(
      within(group).getByRole("radio", { name: "Повреждена" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Утеряна" }));
    expect(calls.onPick).toHaveBeenCalledWith("lost");
    expect(screen.getByText(/Новая попытка по тому же коду спросит свою причину/)).toBeTruthy();
  });

  it("moves the choice with the arrows, as a radio group does", () => {
    const calls = setup("damaged");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Повреждена" }), { key: "ArrowDown" });
    expect(calls.onPick).toHaveBeenCalledWith("lost");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Повреждена" }), { key: "ArrowUp" });
    expect(calls.onPick).toHaveBeenCalledWith("not_printed");
  });

  it("lists boxes, pallets, units and A4 sheets with the printer's state in words", () => {
    setup("damaged");
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
      "box",
      "pallet",
      "unit",
      "sheet",
    ]);
    expect(within(rows[0] as HTMLElement).getByText("Принтер готов")).toBeTruthy();
    // The pallets' printer prints sheets: no label goes to it, and the sheet row has it.
    expect(within(rows[1] as HTMLElement).getByText("Только листы А4")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Принтер готов")).toBeTruthy();
  });

  it("says «Не назначен» with a warning glyph for a kind with no printer, and changes its templates", () => {
    const calls = setup("damaged", { box: null, pallet: null, duplicate: "tsc" });
    expect(screen.getAllByText("Не назначен")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Изменить: Короба" }));
    expect(calls.onChangeTemplates).toHaveBeenCalledWith("box");
  });

  it("starts only with a reason, and offers the workstation and the leave", () => {
    const calls = setup(null);
    expect(
      screen.getByRole("button", { name: "Начать перепечатку" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Рабочее место" }));
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    expect(calls.onSetup).toHaveBeenCalledTimes(1);
    expect(calls.onLeave).toHaveBeenCalledTimes(1);
    cleanup();
    const started = setup("damaged");
    fireEvent.click(screen.getByRole("button", { name: "Начать перепечатку" }));
    expect(started.onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Начать перепечатку" }).className).toContain(
      "floor-primary",
    );
  });
});

describe("the questions over the screen", () => {
  it("asks a new attempt's reason in a dialog that waits for a choice, and cancels with Escape", () => {
    const onPick = vi.fn();
    const onConfirm = vi.fn();
    const onClick = vi.fn();
    const ref = createRef<HTMLElement>();
    const view = wrap(
      <ReasonDialog
        again
        picked={null}
        onPick={onPick}
        onConfirm={onConfirm}
        closeProps={{ onClick }}
        press={press}
        dialogRef={ref}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Причина новой попытки" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText(/код и SSCC не меняются/)).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Напечатать" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Утеряна" }));
    expect(onPick).toHaveBeenCalledWith("lost");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClick).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("keeps the focus inside the dialog: Tab from the last control goes to the first", () => {
    wrap(
      <ReasonDialog
        again={false}
        picked="damaged"
        onPick={vi.fn()}
        onConfirm={vi.fn()}
        closeProps={{ onClick: vi.fn() }}
        press={press}
        dialogRef={createRef<HTMLElement>()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Изменить причину" });
    const apply = within(dialog).getByRole("button", { name: "Применить причину" });
    apply.focus();
    fireEvent.keyDown(apply, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("radio", { name: "Повреждена" }));
  });

  it("asks to finish with what was sent and what still waits for the host", () => {
    const onConfirm = vi.fn();
    wrap(
      <FinishDialog
        sent={4}
        waiting={3}
        onConfirm={onConfirm}
        closeProps={{ onClick: vi.fn() }}
        press={press}
        dialogRef={createRef<HTMLElement>()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Завершить сеанс перепечатки?" });
    expect(within(dialog).getByText(/Этикеток передано на принтер: 4/)).toBeTruthy();
    expect(within(dialog).getByText("Записи ждут отправки на хост: 3")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Завершить" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    cleanup();
    wrap(
      <FinishDialog
        sent={0}
        waiting={0}
        onConfirm={onConfirm}
        closeProps={{ onClick: vi.fn() }}
        press={press}
        dialogRef={createRef<HTMLElement>()}
      />,
    );
    expect(screen.queryByText(/Записи ждут отправки на хост/)).toBeNull();
  });
});

describe("the typed code", () => {
  function manual(value: string, online = true) {
    const calls = { onChange: vi.fn(), onCancel: vi.fn(), onSubmit: vi.fn() };
    wrap(
      <ManualView
        value={value}
        online={online}
        reasonText="Причина: Повреждена"
        press={press}
        submitProps={{}}
        {...calls}
      />,
    );
    return calls;
  }

  it("counts the digits of a box's or pallet's number and says how many are still needed", () => {
    manual("046070123400");
    expect(screen.getByText("12 / 18")).toBeTruthy();
    expect(screen.getByText(/Нужно ещё 6 цифр/)).toBeTruthy();
    expect(screen.getByText("Пока вы вводите номер, сканер не печатает")).toBeTruthy();
    expect(screen.getByText("Искать будем на хосте: нужен «Связь есть».")).toBeTruthy();
  });

  it("types on the keypad: a digit goes on, the backspace takes one off, «Очистить» all", () => {
    const calls = manual("12");
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(calls.onChange).toHaveBeenLastCalledWith("123");
    fireEvent.click(screen.getByRole("button", { name: "Стереть цифру" }));
    expect(calls.onChange).toHaveBeenLastCalledWith("1");
    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(calls.onChange).toHaveBeenLastCalledWith("");
  });

  it("takes a unit's whole code from a hardware keyboard and shuts the keypad for it", () => {
    manual(KM);
    expect(screen.queryByText(/ \/ 18/)).toBeNull();
    expect(screen.getByRole("button", { name: "3" }).hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("button", { name: "Найти и напечатать" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("answers an empty field with a shut button, and leaves by «Отмена» or Escape", () => {
    const calls = manual("");
    expect(
      screen.getByRole("button", { name: "Найти и напечатать" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(calls.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByLabelText(/Номер короба или паллеты/), { key: "Escape" });
    expect(calls.onCancel).toHaveBeenCalledTimes(2);
  });
});
