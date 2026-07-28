import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KioskBootstrapDto } from "../src/api/types.js";
import { classifyKioskScan, type KioskScan } from "../src/domain-guard/classify.js";
import i18n from "../src/i18n/index.js";
import type { ScanListener } from "../src/scanner/source.js";
import { Cart, orientationOf } from "../src/screens/Cart.js";

afterEach(cleanup);

// The i18next instance is a module singleton and the sibling screen tests
// switch it to English. Today Vitest's per-file module isolation keeps that out
// of this file, but the assertions below read RU copy and must not depend on
// an isolation setting to stay true — so pin the language here explicitly.
beforeAll(async () => {
  await i18n.changeLanguage("ru");
});

const GS = String.fromCharCode(0x1d);
// Check-digit-valid GTIN-14s. `payload()` below pushes every fixture through
// the real classifier and throws unless it comes back as the kind the test
// meant, so a mistyped GTIN fails loudly here instead of quietly turning a KM
// case into a not-a-marking-code case. (The prototype's own GTINs are NOT
// check-digit valid and must never be copied into a test.)
const GTIN_MILK = "04600682000013";
const GTIN_BREAD = "04600682000020";
const GTIN_ABSENT = "04600682000037"; // valid code, deliberately not in `products`

/**
 * A raw scanner payload, verified through `classifyKioskScan` to be the kind
 * the test is about. The screen receives raw strings (it classifies them
 * itself), so the fixture is the string — but it is only handed over once the
 * real classifier agrees about what it is.
 */
function payload(expected: KioskScan["kind"], raw: string): string {
  const scan = classifyKioskScan(raw);
  if (scan.kind !== expected) {
    throw new Error(`fixture "${raw}" classified as ${scan.kind}, not ${expected}`);
  }
  return raw;
}

const km = (gtin14: string, serial: string) => payload("km", `01${gtin14}21${serial}${GS}93Abcd`);
/** The same code with the GS separator swallowed by a keyboard wedge. */
const incomplete = () => payload("incomplete", `01${GTIN_MILK}21KYC9X7MQ93Abcd`);
/** The bare EAN printed next to the DataMatrix — the likeliest mis-scan here. */
const bareBarcode = () => payload("unknown", GTIN_MILK);

const MILK = "Молоко 3,2%";
const BREAD = "Хлеб";
const SCAN_PROMPT = "Поднесите бутылку";
const SUBMIT = "Готово — передать администратору";

function bootstrapWith(
  config: { dayLimitPerEmployee?: number; showPrices?: boolean } = {},
): KioskBootstrapDto {
  return {
    generatedAt: "2026-07-28T09:00:00.000Z",
    config: {
      dayLimitPerEmployee: config.dayLimitPerEmployee ?? 5,
      showPrices: config.showPrices ?? true,
    },
    badgeSalt: "c2FsdA==",
    reasons: [
      { id: "reason-defect", name: "Брак" },
      { id: "reason-gift", name: "Подарок" },
    ],
    products: [
      { id: "p-milk", gtin14: GTIN_MILK, name: MILK, unitPrice: "89.90", egaisCode: null },
      { id: "p-bread", gtin14: GTIN_BREAD, name: BREAD, unitPrice: "45.00", egaisCode: null },
    ],
    employees: [],
    operators: [],
  };
}

interface Options {
  bootstrap?: KioskBootstrapDto;
  alreadyTakenToday?: number;
  onScan?: (cb: ScanListener) => void | (() => void);
}

function renderCart(options: Options = {}) {
  let listener: ScanListener | undefined;
  const onSubmit = vi.fn();
  const onNotMe = vi.fn();
  const view = render(
    <Cart
      employee={{ id: "e1", fullName: "Смирнов Алексей" }}
      bootstrap={options.bootstrap ?? bootstrapWith()}
      alreadyTakenToday={options.alreadyTakenToday ?? 0}
      onScan={
        options.onScan ??
        ((cb) => {
          listener = cb;
        })
      }
      onSubmit={onSubmit}
      onNotMe={onNotMe}
    />,
  );
  const scan = (raw: string) => {
    if (!listener) throw new Error("the screen never subscribed to the scanner");
    act(() => listener?.(raw));
  };
  return { ...view, scan, onSubmit, onNotMe };
}

/** The list's rows, as text — enough to assert on both content and length. */
const rows = () => screen.queryAllByRole("listitem").map((li) => li.textContent ?? "");
const submitButton = () => screen.getByRole("button", { name: SUBMIT }) as HTMLButtonElement;
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("Cart", () => {
  it("shows a scanned product with its name, its code tail and its price", () => {
    const { scan } = renderCart();

    scan(km(GTIN_MILK, "KYC9X7MQ"));

    expect(rows()).toHaveLength(1);
    const row = rows().join("");
    expect(row).toContain(MILK);
    expect(row).toContain("…000013-KYC9X7MQ");
    expect(row).toContain("89.90 ₽");
  });

  it("adds up the prices of everything in the list", () => {
    const { scan } = renderCart();

    scan(km(GTIN_MILK, "AAAA1111"));
    scan(km(GTIN_BREAD, "BBBB2222"));

    expect(rows()).toHaveLength(2);
    expect(screen.getByText("134.90 ₽")).toBeDefined();
  });

  it("answers a second scan of the same code with the duplicate banner, and does not grow the list", () => {
    const { scan } = renderCart();
    const repeated = km(GTIN_MILK, "KYC9X7MQ");

    scan(repeated);
    scan(repeated);

    expect(
      screen.getByText("Этот код уже в списке. У каждой бутылки — свой код: возьмите другую."),
    ).toBeDefined();
    expect(rows()).toHaveLength(1);
  });

  // The blocking panel REPLACES the scan zone rather than covering it: a scan
  // prompt still on screen next to «лимит исчерпан» is an invitation the kiosk
  // will refuse, and the worker would keep waving bottles at it.
  it("replaces the scan zone with the limit panel once the day limit is reached", () => {
    const { scan } = renderCart({ bootstrap: bootstrapWith({ dayLimitPerEmployee: 1 }) });
    expect(screen.getByText(SCAN_PROMPT)).toBeDefined();

    scan(km(GTIN_MILK, "KYC9X7MQ"));

    expect(screen.queryByText(SCAN_PROMPT)).toBeNull();
    expect(screen.getByText("Лимит на сегодня — 1 шт")).toBeDefined();
    expect(screen.getByText("Уберите лишнее из списка или нажмите «Готово»")).toBeDefined();
  });

  // What the worker has already taken today counts against the same allowance,
  // so the footer's «осталось» must subtract it — the number is interpolated by
  // i18next, never concatenated.
  it("counts what was taken earlier today against the remaining allowance", () => {
    const { scan } = renderCart({
      bootstrap: bootstrapWith({ dayLimitPerEmployee: 5 }),
      alreadyTakenToday: 1,
    });

    scan(km(GTIN_MILK, "KYC9X7MQ"));

    expect(screen.getByText("Лимит 5 шт в день · осталось 3")).toBeDefined();
  });

  it("opens the red modal for a product this kiosk cannot issue, and dismissing it leaves the list alone", () => {
    const { scan } = renderCart();
    scan(km(GTIN_MILK, "AAAA1111"));
    expect(rows()).toHaveLength(1);

    scan(km(GTIN_ABSENT, "BBBB2222"));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Эту бутылку здесь взять нельзя");
    expect(dialog.textContent).toContain("обратитесь к администратору");

    click("Понятно");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rows()).toHaveLength(1);
    expect(rows().join("")).toContain(MILK);
  });

  it("holds submit until a write-off names its sub-reason, using the bootstrap's reasons", () => {
    const { scan } = renderCart();
    scan(km(GTIN_MILK, "KYC9X7MQ"));
    expect(submitButton().disabled).toBe(false);

    click("Списание");
    expect(submitButton().disabled).toBe(true);

    // The chips are the tenant's own reasons, not a hard-coded list.
    expect(screen.getByRole("button", { name: "Подарок" })).toBeDefined();
    click("Брак");

    expect(submitButton().disabled).toBe(false);
  });

  it("shows no price anywhere when the kiosk is configured to hide them", () => {
    const { scan } = renderCart({ bootstrap: bootstrapWith({ showPrices: false }) });

    // Both products carry a real unitPrice, so this cannot pass vacuously.
    scan(km(GTIN_MILK, "AAAA1111"));
    scan(km(GTIN_BREAD, "BBBB2222"));

    expect(rows()).toHaveLength(2);
    expect(rows().join("")).toContain(MILK);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("89.90");
    expect(text).not.toContain("45.00");
    expect(text).not.toContain("134.90");
    expect(text).not.toContain("₽");
  });

  it("hands the whole session back when the worker says it is not them", () => {
    const { onNotMe } = renderCart();

    click("Не я");

    expect(onNotMe).toHaveBeenCalledTimes(1);
  });

  it("submits the current cart state, and refuses to submit an empty one", () => {
    const { scan, onSubmit } = renderCart();
    expect(submitButton().disabled).toBe(true);

    scan(km(GTIN_MILK, "KYC9X7MQ"));
    click(SUBMIT);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({
      items: [
        {
          rawKm: `01${GTIN_MILK}21KYC9X7MQ${GS}93Abcd`,
          kmKey: `01${GTIN_MILK}21KYC9X7MQ`,
          gtin14: GTIN_MILK,
          productId: "p-milk",
          name: MILK,
          unitPrice: "89.90",
        },
      ],
      reason: "buy",
      writeoffReasonId: null,
      notice: null,
    });
  });

  // Silence here is indistinguishable from a dead scanner, and this is the
  // commonest mis-scan at a kiosk: the plain EAN printed beside the DataMatrix.
  it("says a bare product barcode is not a marking code", () => {
    const { scan } = renderCart();

    scan(bareBarcode());

    expect(screen.getByRole("alert").textContent).toContain("Это обычный штрихкод");
    expect(rows()).toHaveLength(0);
  });

  it("asks for a re-scan when the scanner dropped the GS separator", () => {
    const { scan } = renderCart();

    scan(incomplete());

    expect(screen.getByRole("alert").textContent).toContain("Код считался не полностью");
    expect(rows()).toHaveLength(0);
  });

  it("lets go of the scanner when it leaves the screen", () => {
    const stop = vi.fn();
    const { unmount } = renderCart({ onScan: () => stop });
    expect(stop).not.toHaveBeenCalled();

    unmount();

    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// The kiosk is mounted either way round and the layout switches on flex
// direction alone — no media queries. Keeping the decision in a pure function
// is what lets it be pinned here without a real viewport.
describe("orientationOf", () => {
  it("calls the landscape kiosk landscape", () => {
    expect(orientationOf(1180, 800)).toBe("landscape");
  });

  it("calls the portrait kiosk portrait", () => {
    expect(orientationOf(800, 1180)).toBe("portrait");
  });

  // A square viewport has no taller axis to lay out along, and the two-column
  // landscape layout is the one that fits an unknown shape without stacking.
  it("treats a square viewport as landscape", () => {
    expect(orientationOf(1000, 1000)).toBe("landscape");
  });
});
