import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShiftBoxesPanel } from "../src/ui/ShiftBoxesPanel.js";

const BOXES = [
  {
    boxId: "b1",
    sscc: "123456789012345675",
    itemCount: 3,
    closedAt: "2026-07-30T00:00:00.000Z",
  },
];

describe("ShiftBoxesPanel", () => {
  it("requires a reason before disassembling a closed box", () => {
    const onDisassemble = vi.fn();
    render(<ShiftBoxesPanel boxes={BOXES} onReprint={vi.fn()} onDisassemble={onDisassemble} />);

    fireEvent.click(screen.getByRole("button", { name: "Расформировать" }));
    expect(screen.getByText("Номер короба будет аннулирован навсегда.")).toBeDefined();
    const confirm = screen.getByRole("button", { name: "Подтвердить" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "Причина" }), {
      target: { value: "Чужой заказ" },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    expect(onDisassemble).toHaveBeenCalledWith("b1", "Чужой заказ");
  });

  it("requires and passes a reason when reprinting", () => {
    const onReprint = vi.fn();
    render(<ShiftBoxesPanel boxes={BOXES} onReprint={onReprint} onDisassemble={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Перепечатать" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Причина" }), {
      target: { value: "Замятие этикетки" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

    expect(onReprint).toHaveBeenCalledWith("b1", "Замятие этикетки");
  });
});
