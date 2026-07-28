import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateOrderResultDto, OrderConflict } from "../src/api/types.js";
import i18n from "../src/i18n/index.js";
import { Blocked } from "../src/screens/Blocked.js";
import { Done } from "../src/screens/Done.js";
import { StatusStrip } from "../src/ui/StatusStrip.js";

afterEach(cleanup);

// The i18next instance is a module singleton and the sibling screen tests
// switch it to English. Today Vitest's per-file module isolation keeps that out
// of this file, but the assertions below read RU copy and must not depend on
// an isolation setting to stay true — so pin the language here explicitly.
beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

const ORDER_NO = "ORD-26-0042";
/** Distinctive enough that "is this on screen?" cannot pass by accident. */
const RAW_KM = `010460068200001321KYC9X7MQ${String.fromCharCode(0x1d)}93Abcd`;

const text = () => document.body.textContent ?? "";

function resultWith(over: Partial<CreateOrderResultDto> = {}): CreateOrderResultDto {
  return { orderNo: ORDER_NO, status: "pending", itemCount: 3, conflicts: [], ...over };
}

const conflict = (reason: OrderConflict["reason"]): OrderConflict => ({ rawKm: RAW_KM, reason });

function renderDone(result: CreateOrderResultDto | null, itemCount = 3) {
  const onReset = vi.fn();
  const view = render(<Done result={result} itemCount={itemCount} onReset={onReset} />);
  return { ...view, onReset };
}

/** Ten seconds is the prototype's promise; the tests below hold it to it. */
const AUTO_RESET_MS = 10_000;

describe("Done", () => {
  // Every test here either drives the auto-reset or has to prove it did NOT
  // fire, so the clock is faked for all of them rather than per-test.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prints the order number the server actually gave back", () => {
    renderDone(resultWith());

    expect(screen.getByText(`Заявка № ${ORDER_NO} передана`)).toBeDefined();
    expect(screen.getByText("Сообщите администратору — он оформит заявку")).toBeDefined();
    expect(screen.getByText("и выведет коды из оборота.")).toBeDefined();
  });

  // An order queued offline HAS no number yet — the server assigns it, and the
  // server has not seen this order. Inventing one, or printing a placeholder in
  // the number's shape, sends the worker to the administrator with a number
  // that matches nothing; the administrator then has no way to find the order
  // the worker is standing there talking about.
  it("confirms the handover without a number when the order was queued offline", () => {
    renderDone(null, 2);

    expect(screen.getByText("Заявка передана, номер появится после синхронизации")).toBeDefined();
    // Neither the real prefix nor the «№» that would front a placeholder.
    expect(text()).not.toContain("ORD-");
    expect(text()).not.toContain("№");
    // The confirmation itself is still there: this is a success, not a warning.
    expect(screen.getByText("Сообщите администратору — он оформит заявку")).toBeDefined();
  });

  it("returns the kiosk to the start on its own after ten seconds", () => {
    const { onReset } = renderDone(resultWith());

    act(() => vi.advanceTimersByTime(AUTO_RESET_MS - 1_000));
    expect(onReset).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1_000));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  // A timer left running past unmount is one leaked timer per order, and each
  // one still holds the shell's `onReset`: the kiosk would eventually throw the
  // NEXT worker back to the idle screen mid-cart, on a schedule set by someone
  // else's order.
  it("takes its timer with it when it leaves the screen", () => {
    const { onReset, unmount } = renderDone(resultWith());

    unmount();
    act(() => vi.advanceTimersByTime(AUTO_RESET_MS * 3));

    expect(onReset).not.toHaveBeenCalled();
  });

  it("resets at once when the worker presses «Готово», and never a second time", () => {
    const { onReset } = renderDone(resultWith());

    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onReset).toHaveBeenCalledTimes(1);

    // A worker at a kiosk taps twice, and the timer the button pre-empted must
    // not fire behind them either: a second reset would land on whatever the
    // shell moved to — a fresh session someone else has already started.
    fireEvent.click(screen.getByRole("button", { name: "Готово" }));
    act(() => vi.advanceTimersByTime(AUTO_RESET_MS * 3));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  // Silence here is the one outcome that loses product without anyone
  // noticing: the worker walks off with bottles the order does not contain,
  // and nothing on screen ever said so.
  it("says how much the server refused, and why, without echoing the code", () => {
    renderDone(
      resultWith({ itemCount: 1, conflicts: [conflict("duplicate"), conflict("over_limit")] }),
    );

    expect(screen.getByText(`Заявка № ${ORDER_NO} передана`)).toBeDefined();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Не приняли 2 шт");
    expect(alert.textContent).toContain("дубль — код уже в другой заявке");
    expect(alert.textContent).toContain("превышен дневной лимит");
    // The raw marking code is a code of value; the screen prints reasons only.
    expect(text()).not.toContain(RAW_KM);
    expect(text()).not.toContain("KYC9X7MQ");
  });

  it("keeps quiet about conflicts when the server accepted everything", () => {
    renderDone(resultWith());

    expect(screen.queryByRole("alert")).toBeNull();
    expect(text()).not.toContain("Не приняли");
  });

  // Every reason the DTO can carry gets words. A kind with no entry would
  // otherwise reach the worker as a bare `over_limit`, or throw on the missing
  // i18n key at the worst possible moment — after their order was submitted.
  it.each([
    ["not_km", "это не код маркировки"],
    ["incomplete", "код прочитан не полностью"],
    ["unknown_product", "товара нет в каталоге"],
    ["not_allowed", "этот киоск такое не выдаёт"],
    ["duplicate", "дубль — код уже в другой заявке"],
    ["over_limit", "превышен дневной лимит"],
  ] as [OrderConflict["reason"], string][])("explains the %s conflict in words", (reason, said) => {
    renderDone(resultWith({ itemCount: 0, conflicts: [conflict(reason)] }));

    expect(screen.getByText(said)).toBeDefined();
    expect(text()).not.toContain(reason);
  });

  // The server answers a submission it refused ENTIRELY with an empty orderNo
  // (`pickup-orders.service.ts`: `{ orderNo: "", itemCount: 0, conflicts }`).
  // «Заявка №  передана» with a hole where the number goes is the worst of
  // both readings — it claims an order that does not exist and names it
  // nothing.
  it("does not claim an order the server refused outright", () => {
    renderDone(resultWith({ orderNo: "", itemCount: 0, conflicts: [conflict("not_allowed")] }));

    expect(screen.getByText("Заявку не приняли")).toBeDefined();
    expect(text()).not.toContain("№");
    expect(text()).not.toContain("передана");
  });

  it("tells the worker the screen will return to the start by itself", () => {
    renderDone(resultWith());

    expect(screen.getByText("Экран вернётся к началу через 10 секунд")).toBeDefined();
  });
});

describe("Blocked", () => {
  // A blocked kiosk is not a lost kiosk. What the worker (and the
  // administrator they fetch) needs to know first is that the orders already
  // taken are still owed to the server and still on their way.
  it("promises the queued orders will still reach the server, and counts them", () => {
    render(<Blocked queuedCount={4} />);

    expect(screen.getByText("Киоск временно не выдаёт продукцию")).toBeDefined();
    const said = screen.getByRole("alert").textContent ?? "";
    expect(said).toContain("в очереди: 4");
    expect(said).toContain("уйдут на сервер сами");
  });

  it("does not promise a delivery when the queue is already empty", () => {
    render(<Blocked queuedCount={0} />);

    const said = screen.getByRole("alert").textContent ?? "";
    expect(said).toContain("уже ушли на сервер");
    expect(said).not.toContain("в очереди: 0");
  });
});

describe("StatusStrip", () => {
  it("says the kiosk is online, and says something different when it is not", () => {
    const { rerender } = render(<StatusStrip online age="fresh" />);
    expect(screen.getByText("Связь с сервером есть")).toBeDefined();
    expect(screen.queryByText("Нет связи — киоск работает офлайн")).toBeNull();

    rerender(<StatusStrip online={false} age="fresh" />);

    expect(screen.getByText("Нет связи — киоск работает офлайн")).toBeDefined();
    expect(screen.queryByText("Связь с сервером есть")).toBeNull();
  });

  it("warns once the snapshot is older than a day, and not before", () => {
    const { rerender } = render(<StatusStrip online age="fresh" />);
    expect(screen.queryByText("Данные обновлялись больше суток назад")).toBeNull();

    rerender(<StatusStrip online age="warn" />);

    expect(screen.getByText("Данные обновлялись больше суток назад")).toBeDefined();
  });
});
