import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FloorChoiceGroup } from "../src/ui/FloorChoiceGroup.js";

const CHOICES = [
  { value: "production_defect", label: "Производственный брак" },
  { value: "material_shortage", label: "Недостаток сырья" },
  { value: "equipment_stop", label: "Остановка оборудования" },
];

describe("FloorChoiceGroup", () => {
  it("shows every option as its own control instead of a collapsed dropdown", () => {
    render(
      <FloorChoiceGroup
        label="Причина расхождения"
        choices={CHOICES}
        value="material_shortage"
        onChange={vi.fn()}
      />,
    );

    const options = screen.getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual(
      CHOICES.map((choice) => choice.label),
    );
    // The selection is announced, not only coloured.
    expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(screen.getByRole("radiogroup", { name: "Причина расхождения" })).toBeDefined();
  });

  it("reports a tapped option", () => {
    const onChange = vi.fn();
    render(
      <FloorChoiceGroup
        label="Причина расхождения"
        choices={CHOICES}
        value="production_defect"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Остановка оборудования" }));
    expect(onChange).toHaveBeenCalledWith("equipment_stop");
  });

  it("keeps one tab stop and moves the selection with the arrow keys", () => {
    const onChange = vi.fn();
    render(
      <FloorChoiceGroup
        label="Причина расхождения"
        choices={CHOICES}
        value="material_shortage"
        onChange={onChange}
      />,
    );

    const options = screen.getAllByRole("radio");
    expect(options.map((option) => option.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);

    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("equipment_stop");
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("production_defect");
    // The list wraps, so a gloved operator never reaches a dead end.
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("equipment_stop");
  });

  it("refuses input while the close request is in flight", () => {
    const onChange = vi.fn();
    render(
      <FloorChoiceGroup
        label="Причина расхождения"
        choices={CHOICES}
        value="material_shortage"
        onChange={onChange}
        disabled
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Остановка оборудования" }));
    fireEvent.keyDown(screen.getByRole("radiogroup"), { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
