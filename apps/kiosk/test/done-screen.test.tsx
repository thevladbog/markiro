import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoxConflict, CreateOrderResultDto, OrderConflict } from "../src/api/types.js";
import i18n from "../src/i18n/index.js";
import { Blocked } from "../src/screens/Blocked.js";
import { Done } from "../src/screens/Done.js";
import type { CartState } from "../src/session/cart.js";
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
/** The one caveat an offline confirmation owes the worker. */
const QUEUED_CHECK = "Сервер ещё проверит заявку — часть бутылок может в неё не попасть.";
/** Distinctive enough that "is this on screen?" cannot pass by accident. */
const RAW_KM = `010460068200001321KYC9X7MQ${String.fromCharCode(0x1d)}93Abcd`;

const text = () => document.body.textContent ?? "";

function resultWith(over: Partial<CreateOrderResultDto> = {}): CreateOrderResultDto {
  return { orderNo: ORDER_NO, status: "pending", itemCount: 3, conflicts: [], ...over };
}

const conflict = (reason: OrderConflict["reason"], rawKm = RAW_KM): OrderConflict => ({
  rawKm,
  reason,
});
const SSCC = "346006820000000021";
const boxConflict = (
  reason: BoxConflict["reason"],
  bottleCount: number | null = 12,
): BoxConflict => ({
  sscc: SSCC,
  bottleCount,
  reason,
});

/**
 * The cart as `Cart` handed it to `onSubmit` — the only place the reason and
 * the prices exist, since `CreateOrderResultDto` carries neither.
 *
 * One item per price, because the price is the only field the summary reads;
 * everything else is what a real `CartItem` carries so the fixture cannot drift
 * from the type.
 */
function cartOf(prices: (string | null)[], reason: "buy" | "writeoff" = "buy") {
  return {
    reason,
    lines: prices.map((unitPrice, index) => ({
      kind: "km" as const,
      rawKm: `raw-${index}`,
      kmKey: `key-${index}`,
      gtin14: "04600682000013",
      serial: `S${index}`,
      productId: "p-milk",
      name: "Молоко 3,2%",
      unitPrice,
      bottleCount: 1 as const,
    })),
  };
}

const THREE_BOTTLES = ["89.90", "89.90", "89.90"];

function mixedCart(): Pick<CartState, "lines" | "reason"> {
  return {
    reason: "buy" as const,
    lines: [
      cartOf(["89.90"]).lines[0]!,
      {
        kind: "box" as const,
        boxId: "11111111-1111-4111-8111-111111111111",
        sscc: SSCC,
        productId: "p-milk",
        name: "Молоко 3,2%",
        bottleCount: 12,
        unitPrice: "89.90",
        contentKeys: ["member-secret"],
        registryVersion: "7",
      },
    ],
  };
}

function renderDone(
  result: CreateOrderResultDto | null,
  cart: Pick<CartState, "lines" | "reason"> = cartOf(THREE_BOTTLES),
  showPrices = true,
) {
  const onReset = vi.fn();
  const view = render(
    <Done result={result} cart={cart} showPrices={showPrices} onReset={onReset} />,
  );
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

    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("success");
    expect(screen.getByText("Подтверждено сервером")).toBeDefined();
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
    renderDone(null, cartOf(["89.90", "89.90"]));

    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("warning");
    expect(screen.getByText("Это ещё не подтверждённый успех")).toBeDefined();
    expect(screen.getByText("Заявка передана, номер появится после синхронизации")).toBeDefined();
    // Neither the real prefix nor the «№» that would front a placeholder.
    expect(text()).not.toContain("ORD-");
    expect(text()).not.toContain("№");
    // The confirmation itself is still there: this is a success, not a warning.
    expect(screen.getByText("Сообщите администратору — он оформит заявку")).toBeDefined();
  });

  /**
   * The one thing a queued confirmation cannot say, and has to admit.
   *
   * `conflicts[]` is the server's, and offline there is no `result` at all — so
   * every reason an item can be refused (over the day limit, a duplicate, a
   * product this kiosk does not issue) renders as NOTHING. Online the same
   * worker at least reads «Не приняли N шт». Offline, until this line, the
   * kiosk said the handover succeeded and nobody ever told them otherwise.
   */
  it("admits that a queued order is still to be checked by the server", () => {
    renderDone(null, cartOf(["89.90", "89.90"]));

    expect(screen.getByText(QUEUED_CHECK)).toBeDefined();
    // Still a confirmation, not a warning screen: the headline and the
    // instruction that follows it are unchanged.
    expect(screen.getByText("Заявка передана, номер появится после синхронизации")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing of the sort once the server has actually answered", () => {
    renderDone(resultWith());

    expect(text()).not.toContain(QUEUED_CHECK);
  });

  it("says nothing of the sort when the server refused the order outright", () => {
    renderDone(resultWith({ orderNo: "", itemCount: 0, conflicts: [conflict("over_limit")] }));

    expect(screen.getByRole("status").getAttribute("data-tone")).toBe("error");
    expect(text()).not.toContain(QUEUED_CHECK);
  });

  it("describes a rejected box without exposing its member keys", () => {
    renderDone(
      resultWith({ orderNo: "", itemCount: 0, boxConflicts: [boxConflict("duplicate")] }),
      mixedCart(),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("…000021");
    expect(alert.textContent).toContain("12 бутылок не попали в операцию");
    expect(text()).not.toContain("member-secret");
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

  /**
   * A reason this build has never heard of, which is not hypothetical: the DTO
   * crosses the network unvalidated, so a reason added server-side reaches an
   * un-updated kiosk exactly like this. The compile-time `Record` says nothing
   * about it, and the missing i18n key throws in test mode — on the ONE screen
   * where going blank costs the most, because the worker is already holding the
   * product and this list is what tells them to put it back.
   */
  it("survives a conflict reason it has never heard of, and still counts it", () => {
    const unknown = "quarantined" as OrderConflict["reason"];
    renderDone(resultWith({ itemCount: 0, conflicts: [conflict("duplicate"), conflict(unknown)] }));

    const alert = screen.getByRole("alert");
    // Counted, listed, and named as a refusal — only the WHY is deferred, which
    // is honest: at this point the kiosk genuinely does not know it.
    expect(alert.textContent).toContain("Не приняли 2 шт");
    expect(alert.textContent).toContain("дубль — код уже в другой заявке");
    expect(alert.textContent).toContain("уточните у администратора");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // Never the raw kind: «quarantined» on a kiosk screen is not copy.
    expect(text()).not.toContain(unknown);
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

  /**
   * THE SUMMARY, in the shape design 2026-07-24 §8.3 asks for: «сводка (причина
   * · штук · сумма)». Until now this screen printed the count and nothing else,
   * so the worker had no way to check that the thing they were about to walk
   * away with was filed as a PURCHASE rather than a write-off.
   */
  it("summarises the order as reason · count · sum", () => {
    renderDone(resultWith());

    // The decimal COMMA: this kiosk speaks Russian and the price list it is fed
    // is written «89,90». 3 × 8990 kopecks, added as integers.
    expect(screen.getByText("Покупка · 3 шт · 269,70 ₽")).toBeDefined();
  });

  it("names a write-off as a write-off", () => {
    renderDone(resultWith(), cartOf(THREE_BOTTLES, "writeoff"));

    expect(screen.getByText("Списание · 3 шт · 269,70 ₽")).toBeDefined();
  });

  /**
   * The separator follows the LANGUAGE and is not a second hard-coded
   * character, exactly as on the cart it summarises — pinned from both sides so
   * a future edit cannot satisfy one and break the other.
   */
  it("prints the same sum with a dot when the kiosk is switched to English", async () => {
    await i18n.changeLanguage("en");
    try {
      renderDone(resultWith());

      expect(screen.getByText("Purchase · 3 pcs · 269.70 ₽")).toBeDefined();
    } finally {
      await i18n.changeLanguage("ru");
    }
  });

  /**
   * «—», never a sum with the unpriced bottle quietly left out: this is the
   * number the administrator charges against, and an understated one is worse
   * than no number at all. The rule `Cart`'s footer already follows.
   */
  it("states no sum at all when one of the items has no price", () => {
    renderDone(resultWith(), cartOf(["89.90", null, "89.90"]));

    expect(screen.getByText("Покупка · 3 шт · —")).toBeDefined();
    expect(text()).not.toContain("179,80");
  });

  it("does not silently zero a price it cannot parse", () => {
    renderDone(resultWith(), cartOf(["89.90", "не число", "89.90"]));

    expect(screen.getByText("Покупка · 3 шт · —")).toBeDefined();
    expect(text()).not.toContain("0,00");
  });

  /**
   * The device knows what the worker SCANNED, not which of it the server kept.
   * With a partial acceptance the count is the server's and the prices are the
   * kiosk's, so multiplying the two out would print a confident overstatement of
   * an order the worker is about to be charged for.
   */
  it("states no sum for an order the server only partly accepted", () => {
    renderDone(resultWith({ itemCount: 2, conflicts: [conflict("duplicate")] }));

    expect(screen.getByText("Покупка · 2 шт · —")).toBeDefined();
    expect(text()).not.toContain("269,70");
  });

  it("renders a box-only partial as partial and prices only the accepted loose bottle", () => {
    renderDone(
      resultWith({
        itemCount: 1,
        conflicts: [],
        boxConflicts: [boxConflict("duplicate")],
        acceptedBoxes: [],
      }),
      mixedCart(),
    );

    expect(screen.getByRole("alert").textContent).toContain("короб");
    expect(screen.getByText("Покупка · 1 шт · 89,90 ₽")).toBeDefined();
    expect(text()).not.toContain("member-secret");
    expect(text()).not.toContain("1 168,70");
  });

  it("prices a mixed partial from the server-accepted box set", () => {
    renderDone(
      resultWith({
        itemCount: 12,
        conflicts: [conflict("duplicate", "raw-0")],
        boxConflicts: [],
        acceptedBoxes: [{ sscc: SSCC, bottleCount: 12 }],
      }),
      mixedCart(),
    );

    expect(screen.getByText("Покупка · 12 шт · 1 078,80 ₽")).toBeDefined();
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("prices a fully accepted box and still hides all money when configured", () => {
    const accepted = resultWith({
      itemCount: 12,
      conflicts: [],
      boxConflicts: [],
      acceptedBoxes: [{ sscc: SSCC, bottleCount: 12 }],
    });
    const cart = { ...mixedCart(), lines: [mixedCart().lines[1]!] };
    const visible = renderDone(accepted, cart);
    expect(screen.getByText("Покупка · 12 шт · 1 078,80 ₽")).toBeDefined();

    visible.unmount();
    renderDone(accepted, cart, false);
    expect(screen.getByText("Покупка · 12 шт")).toBeDefined();
    expect(text()).not.toContain("₽");
  });

  // `showPrices = false` hides money everywhere on this device, and a summary
  // that leaked it here would be the one screen that did not honour it.
  it("leaves the money out entirely when the kiosk hides prices", () => {
    renderDone(resultWith(), cartOf(THREE_BOTTLES), false);

    expect(screen.getByText("Покупка · 3 шт")).toBeDefined();
    expect(text()).not.toContain("₽");
    expect(text()).not.toContain("269,70");
  });

  // Nothing was accepted, the headline already says so, and «0 шт» under it is
  // noise — as is a reason for an order that does not exist.
  it("skips the summary entirely for an order the server refused outright", () => {
    renderDone(resultWith({ orderNo: "", itemCount: 0, conflicts: [conflict("not_allowed")] }));

    expect(text()).not.toContain("Покупка");
    expect(text()).not.toContain("0 шт");
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

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

describe("StatusStrip", () => {
  it("says the kiosk is online, and says something different when it is not", () => {
    const { rerender } = render(<StatusStrip online age="fresh" ageMs={0} quarantined={0} />);
    expect(screen.getByText("Связь с сервером есть")).toBeDefined();
    expect(screen.queryByText("Нет связи — киоск работает офлайн")).toBeNull();

    rerender(<StatusStrip online={false} age="fresh" ageMs={0} quarantined={0} />);

    expect(screen.getByText("Нет связи — киоск работает офлайн")).toBeDefined();
    expect(screen.queryByText("Связь с сервером есть")).toBeNull();
  });

  /**
   * «Данные обновлялись N назад» — the plaque design 2026-07-24 §7 asks for by
   * name, and the half that was missing: the threshold was enforced but the
   * strip only ever said «больше суток назад», which is the same sentence on
   * the second day and on the sixth.
   *
   * The AGE is what an administrator walking past needs, because it is the only
   * thing that distinguishes a kiosk whose Wi-Fi dropped after lunch from one
   * that has been quietly off the network since Friday — and the second is the
   * one that is about to stop handing product out.
   */
  it("names how long ago the data was refreshed, not merely that it is old", () => {
    const { rerender } = render(<StatusStrip online age="fresh" ageMs={HOUR} quarantined={0} />);
    // Nothing at all while the dataset is young: this plaque is for the
    // exception, and a permanent line about freshness is one nobody reads.
    expect(text()).not.toContain("обновлялись");

    rerender(<StatusStrip online age="warn" ageMs={30 * HOUR} quarantined={0} />);
    expect(screen.getByText("Данные обновлялись 30 ч назад")).toBeDefined();

    rerender(<StatusStrip online age="warn" ageMs={3 * DAY + 5 * HOUR} quarantined={0} />);
    expect(screen.getByText("Данные обновлялись 3 сут назад")).toBeDefined();
  });

  // Strictly worse than a day old, so staying silent here would be the strip
  // asserting freshness at the exact moment it is least true.
  it("keeps naming the age past the blocking threshold", () => {
    render(<StatusStrip online={false} age="blocked" ageMs={9 * DAY} quarantined={0} />);

    expect(screen.getByText("Данные обновлялись 9 сут назад")).toBeDefined();
  });

  /**
   * And when the age cannot be established at all — a paired device holding no
   * snapshot, or one whose stamps are unreadable — it says the threshold rather
   * than inventing a number. `snapshotAgeMs` answers `null` for exactly the
   * cases `snapshotAge` calls `blocked`, so this is reachable and is the one
   * state where the old wording is still the true one.
   */
  it("falls back to the threshold when there is no measurable age", () => {
    render(<StatusStrip online={false} age="blocked" ageMs={null} quarantined={0} />);

    expect(screen.getByText("Данные обновлялись больше суток назад")).toBeDefined();
  });

  /**
   * A permanently refused order is invisible everywhere else: it has left the
   * queue (so `Blocked`'s count no longer covers it), it will never be retried,
   * and the worker it belonged to walked away long ago. Without a word here a
   * kiosk can sit for weeks holding a pickup nobody will ever look at.
   *
   * It is stated only when there IS one: a permanent «отложено: 0» would train
   * everyone who walks past the kiosk to read straight through the line on the
   * day it finally says something.
   */
  it("says nothing about quarantine while nothing has been set aside", () => {
    render(<StatusStrip online age="fresh" ageMs={0} quarantined={0} />);

    expect(text()).not.toContain("отклонил");
    expect(text()).not.toContain("администратор");
  });

  /**
   * And when there is one, it names the count and names WHOSE problem it is.
   *
   * The count so an administrator can reconcile it against the panel, the way
   * `Blocked` states its queue; the administrator because nothing the worker
   * standing here can do will clear it — a strip that merely went red would
   * send them to fetch someone for a kiosk that is otherwise working perfectly.
   */
  it("names the orders the server refused for good, and whose problem they are", () => {
    render(<StatusStrip online age="fresh" ageMs={0} quarantined={2} />);

    expect(text()).toContain("Сервер отклонил заявки: 2");
    expect(text()).toContain("нужен администратор");
    // Calm, not alarming: the kiosk is still online and still handing product
    // out, and this must not read as a failure of the pickup in progress.
    expect(screen.getByText("Связь с сервером есть")).toBeDefined();
  });
});
