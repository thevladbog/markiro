import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import { OperatorSwitchControl } from "../src/ui/OperatorSwitchControl.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function renderControl(
  options: {
    activeShift?: boolean;
    pending?: boolean;
    error?: boolean;
    onSwitch?: () => Promise<void>;
    onDismissError?: () => void;
  } = {},
) {
  return render(
    <OperatorSwitchControl
      activeShift={options.activeShift ?? false}
      pending={options.pending ?? false}
      error={options.error ?? false}
      onSwitch={options.onSwitch ?? vi.fn(async () => {})}
      onDismissError={options.onDismissError ?? vi.fn()}
    />,
  );
}

describe("OperatorSwitchControl", () => {
  it("switches immediately when no shift is active", async () => {
    const onSwitch = vi.fn(async () => {});
    renderControl({ onSwitch });

    fireEvent.click(screen.getByRole("button", { name: "Change operator" }));

    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts only one switch while the first request is in flight", async () => {
    let resolveSwitch: (() => void) | undefined;
    const onSwitch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    renderControl({ onSwitch });

    const action = screen.getByRole("button", { name: "Change operator" });
    fireEvent.click(action);
    fireEvent.click(action);

    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect((action as HTMLButtonElement).disabled).toBe(true);
    resolveSwitch?.();
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
  });

  it("requires confirmation while a shift is active and Stay cancels it", () => {
    const onSwitch = vi.fn(async () => {});
    renderControl({ activeShift: true, onSwitch });

    fireEvent.click(screen.getByRole("button", { name: "Change operator" }));

    expect(screen.getByRole("dialog", { name: "Change operator?" })).toBeDefined();
    expect(onSwitch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("confirms an active-shift switch exactly once", async () => {
    const onSwitch = vi.fn(async () => {});
    renderControl({ activeShift: true, onSwitch });

    fireEvent.click(screen.getByRole("button", { name: "Change operator" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Change operator?" })).getByRole("button", {
        name: "Change operator",
      }),
    );

    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("disables the action and shows bounded progress while local work settles", () => {
    renderControl({ pending: true });

    const action = screen.getByRole("button", { name: "Saving the current operation…" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect(action.className).toContain("mk-btn--floor");
    expect(action.textContent).toBe("Saving the current operation…");
  });

  it("keeps a touch-sized retryable control mounted after rejection", async () => {
    const onSwitch = vi.fn(async () => {
      throw new Error("local detail must stay hidden");
    });
    const onDismissError = vi.fn();
    const view = renderControl({ onSwitch, onDismissError });

    fireEvent.click(screen.getByRole("button", { name: "Change operator" }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    view.rerender(
      <OperatorSwitchControl
        activeShift={false}
        pending={false}
        error
        onSwitch={onSwitch}
        onDismissError={onDismissError}
      />,
    );

    expect(screen.getByRole("button", { name: "Change operator" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not change operator. The current operator and local work remain active.",
    );
    const retry = screen.getByRole("button", { name: "Retry operator change" });
    expect(retry.className).toContain("mk-btn--floor");
    expect(retry.style.height).toBe("var(--control-floor)");
    expect(retry.style.minWidth).toBe("var(--control-floor)");

    fireEvent.click(retry);
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(2));
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });
});
