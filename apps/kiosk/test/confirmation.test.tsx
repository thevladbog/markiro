import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { Confirmation } from "../src/screens/Confirmation.js";
import type { BoxLine, CartItem, CartState } from "../src/session/cart.js";

afterEach(cleanup);
beforeAll(async () => i18n.changeLanguage("ru"));

const bottle = (index: number, unitPrice: string | null = "89.90"): CartItem => ({
  kind: "km",
  rawKm: `raw-${index}`,
  kmKey: `key-${index}`,
  gtin14: "04600682000013",
  serial: `SERIAL-${index}`,
  productId: "p1",
  name: `Молоко ${index}`,
  unitPrice,
  bottleCount: 1,
});
const box: BoxLine = {
  kind: "box",
  boxId: "11111111-1111-4111-8111-111111111111",
  sscc: "346006820000000021",
  productId: "p1",
  name: "Молоко",
  bottleCount: 12,
  unitPrice: "89.90",
  contentKeys: ["must-not-render"],
  registryVersion: "1",
};
const cart = (lines: CartState["lines"], reason: CartState["reason"] = "buy"): CartState => ({
  lines,
  reason,
  writeoffReasonId: reason === "writeoff" ? "damage" : null,
  notice: null,
});

describe("Confirmation", () => {
  const portrait = () => {
    Object.defineProperty(window, "innerWidth", { value: 480, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  };

  it("shows the operation exactly once and uses the approved pluralized confirm CTA", () => {
    portrait();
    render(
      <Confirmation
        cart={cart([bottle(1), bottle(2), box])}
        showPrices
        reasonName={null}
        pending={false}
        onBack={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Через кассу")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Подтвердить 14 бутылок" })).toBeDefined();
    expect(screen.queryByRole("button", { name: /Отправить/ })).toBeNull();
    expect(screen.getByText("3 позиции · 14 бутылок")).toBeDefined();
    expect(screen.getByText("Отдельно: 2 · Коробов: 1")).toBeDefined();
    expect(document.body.textContent).not.toContain("must-not-render");
  });

  it("pages the summary without scrolling and hides all money when configured", () => {
    portrait();
    render(
      <Confirmation
        cart={cart(Array.from({ length: 6 }, (_, index) => bottle(index + 1)))}
        showPrices={false}
        reasonName={null}
        pending={false}
        onBack={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByText("1 / 2")).toBeDefined();
    expect(
      (document.querySelector(".kiosk-confirmation__summary") as HTMLElement).style.overflow,
    ).toBe("hidden");
    expect(document.body.textContent).not.toContain("₽");
  });

  it("shows a total only when every visible bottle has a price", () => {
    portrait();
    const { rerender } = render(
      <Confirmation
        cart={cart([bottle(1), box])}
        showPrices
        reasonName={null}
        pending={false}
        onBack={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 168,70 ₽/)).toBeDefined();

    rerender(
      <Confirmation
        cart={cart([bottle(1), bottle(2, null)])}
        showPrices
        reasonName={null}
        pending={false}
        onBack={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(document.body.textContent).not.toContain("₽");
  });

  it("locks a double tap synchronously until the enqueue promise settles", async () => {
    portrait();
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const onConfirm = vi.fn(() => pending);
    render(
      <Confirmation
        cart={cart([bottle(1)])}
        showPrices
        reasonName={null}
        pending={false}
        onBack={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: "Подтвердить 1 бутылку" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    settle();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it("does not allow a stale writeoff reason to be confirmed", () => {
    portrait();
    const onConfirm = vi.fn();
    render(
      <Confirmation
        cart={cart([bottle(1)], "writeoff")}
        showPrices
        reasonName={null}
        pending={false}
        onBack={vi.fn()}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Подтвердить 1 бутылку" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Причина списания больше недоступна");
  });

  it("disables back and cancel while the reducer says submission is pending", () => {
    portrait();
    const onBack = vi.fn();
    const onCancel = vi.fn();
    render(
      <Confirmation
        cart={cart([bottle(1)])}
        showPrices
        reasonName={null}
        pending
        onBack={onBack}
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />,
    );

    const header = document.querySelector(".kiosk-flow__header") as HTMLElement;
    expect((header.querySelector(".kiosk-flow__back") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Отменить операцию" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(header.querySelector(".kiosk-flow__back") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Отменить операцию" }));
    expect(onBack).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
