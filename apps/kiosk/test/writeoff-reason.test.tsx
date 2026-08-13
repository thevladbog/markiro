import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { WriteoffReason } from "../src/screens/WriteoffReason.js";

afterEach(cleanup);
beforeAll(async () => i18n.changeLanguage("ru"));

const reasons = Array.from({ length: 7 }, (_, index) => ({
  id: `reason-${index + 1}`,
  name: `Причина ${index + 1}`,
}));

describe("WriteoffReason", () => {
  it("pages active reasons in groups of six without a scrolling list", () => {
    render(
      <WriteoffReason
        reasons={reasons}
        selectedId={null}
        onSelect={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("radio")).toHaveLength(6);
    expect(screen.getByText("1 / 2")).toBeDefined();
    expect(screen.queryByText("Причина 7")).toBeNull();
    expect((document.querySelector(".kiosk-reasons__grid") as HTMLElement).style.overflow).toBe(
      "hidden",
    );
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(screen.getByRole("radio", { name: "Причина 7" })).toBeDefined();
  });

  it("requires a currently active reason before continuing", () => {
    const onSelect = vi.fn();
    const onContinue = vi.fn();
    const { rerender } = render(
      <WriteoffReason
        reasons={reasons}
        selectedId={null}
        onSelect={onSelect}
        onContinue={onContinue}
        onBack={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Продолжить" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Причина 2" }));
    expect(onSelect).toHaveBeenCalledWith("reason-2");
    rerender(
      <WriteoffReason
        reasons={reasons}
        selectedId="reason-2"
        onSelect={onSelect}
        onContinue={onContinue}
        onBack={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("fails closed if a selected reason disappears on refresh", () => {
    render(
      <WriteoffReason
        reasons={reasons.slice(1)}
        selectedId="reason-1"
        onSelect={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect((screen.getByRole("button", { name: "Продолжить" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("groups reasons and moves selection and focus across pages with arrow keys", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <WriteoffReason
        reasons={reasons}
        selectedId="reason-6"
        onSelect={onSelect}
        onContinue={vi.fn()}
        onBack={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Выберите причину списания" })).toBeDefined();
    const sixth = screen.getByRole("radio", { name: "Причина 6" });
    sixth.focus();
    fireEvent.keyDown(sixth, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("reason-7");

    rerender(
      <WriteoffReason
        reasons={reasons}
        selectedId="reason-7"
        onSelect={onSelect}
        onContinue={vi.fn()}
        onBack={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("2 / 2")).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Причина 7" }));
  });
});
