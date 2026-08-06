import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ShiftBoxesPanel } from "../src/ui/ShiftBoxesPanel.js";

const BOXES = Array.from({ length: 6 }, (_, index) => ({
  boxId: `b${index + 1}`,
  sscc: `12345678901234567${index}`,
  itemCount: index + 1,
  closedAt: `2026-07-30T00:0${5 - index}:00.000Z`,
}));

describe("ShiftBoxesPanel", () => {
  it("renders a bounded page of four boxes and pages in the supplied newest-first order", () => {
    const onSelectionChange = vi.fn();
    render(
      <ShiftBoxesPanel boxes={BOXES} selectedBoxId={null} onSelectionChange={onSelectionChange} />,
    );

    expect(screen.getAllByRole("button", { name: /SSCC/ })).toHaveLength(4);
    expect(screen.getByRole("button", { name: /123456789012345670/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /123456789012345674/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
    expect(screen.getAllByRole("button", { name: /SSCC/ })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /123456789012345674/ })).toBeDefined();
    expect(screen.getByText("Страница 2 из 2")).toBeDefined();
  });

  it("reports the selected box and drops selection when that box leaves the dataset", () => {
    const onSelectionChange = vi.fn();
    const view = render(
      <ShiftBoxesPanel boxes={BOXES} selectedBoxId={null} onSelectionChange={onSelectionChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /123456789012345670/ }));
    expect(onSelectionChange).toHaveBeenLastCalledWith(BOXES[0]);

    view.rerender(
      <ShiftBoxesPanel
        boxes={BOXES.slice(1)}
        selectedBoxId="b1"
        onSelectionChange={onSelectionChange}
      />,
    );
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });

  it("clamps the current page when the dataset shrinks", () => {
    const view = render(
      <ShiftBoxesPanel boxes={BOXES} selectedBoxId={null} onSelectionChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
    expect(screen.getByText("Страница 2 из 2")).toBeDefined();

    view.rerender(
      <ShiftBoxesPanel
        boxes={BOXES.slice(0, 2)}
        selectedBoxId={null}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Страница 1 из 1")).toBeDefined();
  });
});
