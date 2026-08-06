import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PinPad } from "../src/components/PinPad.js";

afterEach(cleanup);

describe("PinPad", () => {
  it("appends the pressed digit", () => {
    const onChange = vi.fn();
    render(<PinPad value="12" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    expect(onChange).toHaveBeenCalledWith("123");
  });

  it("refuses to grow past maxLength — the pairing code is exactly eight digits", () => {
    const onChange = vi.fn();
    render(<PinPad value="12345678" onChange={onChange} maxLength={8} />);
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is unbounded when maxLength is omitted, as the station's PIN entry expects", () => {
    const onChange = vi.fn();
    render(<PinPad value="123456789012" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    expect(onChange).toHaveBeenCalledWith("1234567890120");
  });

  it("renders a deliberate 3 by 4 floor grid with labelled correction controls", () => {
    render(<PinPad value="12" onChange={() => undefined} size="floor" />);

    const keypad = screen.getByRole("group", { name: "Numeric keypad" });
    expect(keypad.style.gridTemplateColumns).toBe("repeat(3, var(--control-keypad))");
    const keys = screen.getAllByRole("button");
    expect(keys).toHaveLength(12);
    expect(keys.map((key) => key.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "Backspace",
      "0",
      "Clear",
    ]);
    expect(screen.getByRole("button", { name: "0" }).style.minHeight).toBe("var(--control-keypad)");
  });

  it("supports Backspace and Clear without exceeding the exact maximum length", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PinPad value="12" onChange={onChange} maxLength={2} size="floor" />,
    );

    expect((screen.getByRole("button", { name: "3" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "3" }));
    fireEvent.click(screen.getByRole("button", { name: "Backspace" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange.mock.calls).toEqual([["1"], [""]]);

    rerender(<PinPad value="1" onChange={onChange} maxLength={2} size="floor" />);
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    expect(onChange).toHaveBeenLastCalledWith("10");
  });
});
