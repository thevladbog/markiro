import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { OperationChoice } from "../src/screens/OperationChoice.js";

afterEach(cleanup);
beforeAll(async () => i18n.changeLanguage("ru"));

describe("OperationChoice", () => {
  it("offers the two approved touch operations and emits the selected one", () => {
    const onChoose = vi.fn();
    render(
      <OperationChoice writeoffAvailable onChoose={onChoose} onBack={vi.fn()} onCancel={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Через кассу/ }));
    fireEvent.click(screen.getByRole("button", { name: /Списание/ }));
    expect(onChoose.mock.calls).toEqual([["buy"], ["writeoff"]]);
  });

  it("keeps navigation separate and requires confirmation before cancelling", () => {
    const onBack = vi.fn();
    const onCancel = vi.fn();
    render(
      <OperationChoice writeoffAvailable onChoose={vi.fn()} onBack={onBack} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Отменить операцию" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("Очистить список и выйти?");
    fireEvent.click(screen.getByRole("button", { name: "Да, очистить и выйти" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the tenant has no active writeoff reason", () => {
    render(
      <OperationChoice
        writeoffAvailable={false}
        onChoose={vi.fn()}
        onBack={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: /Списание/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/администратор должен добавить активную причину/i)).toBeDefined();
  });
});
