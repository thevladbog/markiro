import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Pairing } from "../src/pages/Pairing.js";

describe("Pairing", () => {
  it("submits an eight digit code and reports success", async () => {
    const onPair = vi.fn().mockResolvedValue({ ok: true, tenantName: "ООО Ромашка" });
    render(<Pairing onPair={onPair} hostname="BUH-PC" />);
    await userEvent.type(screen.getByLabelText(/код привязки|pairing code/i), "01234567");
    await userEvent.click(screen.getByRole("button", { name: /привязать|pair/i }));
    expect(onPair).toHaveBeenCalledWith("01234567");
  });

  it("accepts a cabinet code pasted with a visual separator", async () => {
    const onPair = vi.fn().mockResolvedValue({ ok: true, tenantName: "ООО Ромашка" });
    const user = userEvent.setup();
    render(<Pairing onPair={onPair} hostname="BUH-PC" />);

    const input = screen.getByLabelText(/код привязки|pairing code/i);
    await user.click(input);
    await user.paste("0123 4567");
    await user.click(screen.getByRole("button", { name: /привязать|pair/i }));

    expect(onPair).toHaveBeenCalledWith("01234567");
  });

  it("keeps the button disabled until the code is complete", async () => {
    const onPair = vi.fn();
    render(<Pairing onPair={onPair} hostname="BUH-PC" />);
    await userEvent.type(screen.getByLabelText(/код привязки|pairing code/i), "0123");
    // No jest-dom matcher in this project's setup (see WorkstationSetup's own
    // tests), so assert the DOM attribute directly.
    expect(
      (screen.getByRole("button", { name: /привязать|pair/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("surfaces a rejected code without guessing why", async () => {
    const onPair = vi.fn().mockResolvedValue({ ok: false, error: "rejected" });
    render(<Pairing onPair={onPair} hostname="BUH-PC" />);
    await userEvent.type(screen.getByLabelText(/код привязки|pairing code/i), "00000000");
    await userEvent.click(screen.getByRole("button", { name: /привязать|pair/i }));
    // findByText already throws if the element is absent, so the assertion
    // on the returned element adds no meaning here.
    await screen.findByText(/недействителен|not valid/i);
  });
});
