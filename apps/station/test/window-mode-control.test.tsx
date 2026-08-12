import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "../src/i18n/index.js";
import type { LockdownSnapshot } from "../src/lib/lockdown.js";
import { WindowModeControl } from "../src/ui/WindowModeControl.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function renderControl(
  snapshot: LockdownSnapshot,
  options: {
    activeShift?: boolean;
    onEnter?: () => void;
    onExit?: () => void;
    onDismissError?: () => void;
  } = {},
) {
  return render(
    <WindowModeControl
      snapshot={snapshot}
      activeShift={options.activeShift ?? false}
      onEnter={options.onEnter ?? vi.fn()}
      onExit={options.onExit ?? vi.fn()}
      onDismissError={options.onDismissError ?? vi.fn()}
    />,
  );
}

describe("WindowModeControl", () => {
  it("exits immediately outside an active shift", () => {
    const onExit = vi.fn();
    renderControl({ mode: "locked", pending: false, error: null }, { onExit });

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));

    expect(onExit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("requires confirmation before exiting during an active shift", () => {
    const onExit = vi.fn();
    renderControl({ mode: "locked", pending: false, error: null }, { activeShift: true, onExit });

    fireEvent.click(screen.getByRole("button", { name: "Exit fullscreen" }));

    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Exit fullscreen?" })).toBeDefined();
    expect(screen.getByText(/Production continues.*only the window mode changes/i)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Confirm exit fullscreen" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("re-enters lockdown from confirmed windowed mode", () => {
    const onEnter = vi.fn();
    renderControl({ mode: "windowed", pending: false, error: null }, { onEnter });

    fireEvent.click(screen.getByRole("button", { name: "Return to fullscreen" }));

    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("disables repeated mode actions while a command is pending", () => {
    const onEnter = vi.fn();
    renderControl({ mode: "windowed", pending: true, error: null }, { onEnter });

    const action = screen.getByRole("button", { name: "Changing window mode…" });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(action);
    expect(onEnter).not.toHaveBeenCalled();
  });

  it("renders localized safe failure copy and dismisses it explicitly", () => {
    const onDismissError = vi.fn();
    renderControl({ mode: "locked", pending: false, error: "exit" }, { onDismissError });

    expect(screen.getByRole("alert").textContent).toContain(
      "Could not leave fullscreen. Production continues; try again.",
    );
    expect(document.body.textContent).not.toContain("secret-device-key");

    const dismiss = screen.getByRole("button", { name: "Dismiss window mode error" });
    expect(dismiss.className).toContain("mk-btn--floor");
    expect(dismiss.style.height).toBe("var(--control-floor)");
    expect(dismiss.style.minWidth).toBe("var(--control-floor)");
    fireEvent.click(dismiss);
    expect(onDismissError).toHaveBeenCalledTimes(1);
  });

  it("keeps the persistent action touch-sized and accessibly named", () => {
    renderControl({ mode: "locked", pending: false, error: null });

    const action = screen.getByRole("button", { name: "Exit fullscreen" });
    expect(action.className).toContain("mk-btn--floor");
    expect(action.style.height).toBe("var(--control-floor)");
    expect(action.style.minWidth).toBe("var(--control-floor)");
  });
});
