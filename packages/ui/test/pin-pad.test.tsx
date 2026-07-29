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
});
