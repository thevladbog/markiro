import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutostartControl } from "../src/components/AutostartControl.js";
import { bridge } from "../src/lib/bridge.js";

vi.mock("../src/lib/bridge.js", () => ({
  bridge: { autostartEnabled: vi.fn(), setAutostartEnabled: vi.fn() },
}));

const checkbox = () =>
  screen.getByRole("checkbox", {
    name: /Запускать при входе в Windows|Start when signing in to Windows/,
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(bridge.autostartEnabled).mockResolvedValue(true);
  vi.mocked(bridge.setAutostartEnabled).mockResolvedValue(undefined);
});

describe("signer autostart", () => {
  it("does not let an old initial read overwrite a saved choice in Strict Mode", async () => {
    let resolve!: (enabled: boolean) => void;
    vi.mocked(bridge.autostartEnabled).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    vi.mocked(bridge.setAutostartEnabled).mockImplementation(async (enabled) => {
      vi.mocked(bridge.autostartEnabled).mockResolvedValue(enabled);
    });
    render(
      <StrictMode>
        <AutostartControl />
      </StrictMode>,
    );
    await waitFor(() => expect(checkbox().hasAttribute("disabled")).toBe(false));
    await userEvent.setup().click(checkbox());
    await waitFor(() => expect(checkbox().getAttribute("aria-checked")).toBe("false"));
    await act(async () => resolve(true));
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
  });

  it("reads the system setting without changing it and disables input while loading", async () => {
    let resolve!: (enabled: boolean) => void;
    vi.mocked(bridge.autostartEnabled).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<AutostartControl />);
    expect(checkbox().hasAttribute("disabled")).toBe(true);
    await act(async () => resolve(true));
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
    expect(bridge.setAutostartEnabled).not.toHaveBeenCalled();
  });

  it("saves both directions and restores the persisted state after remount", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.setAutostartEnabled).mockImplementation(async (enabled) => {
      vi.mocked(bridge.autostartEnabled).mockResolvedValue(enabled);
    });
    const view = render(<AutostartControl />);
    await waitFor(() => expect(checkbox().hasAttribute("disabled")).toBe(false));
    await user.click(checkbox());
    expect(bridge.setAutostartEnabled).toHaveBeenLastCalledWith(false);
    await waitFor(() => expect(checkbox().getAttribute("aria-checked")).toBe("false"));
    view.unmount();
    render(<AutostartControl />);
    await waitFor(() => expect(checkbox().hasAttribute("disabled")).toBe(false));
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    await user.click(checkbox());
    expect(bridge.setAutostartEnabled).toHaveBeenLastCalledWith(true);
    await waitFor(() => expect(checkbox().getAttribute("aria-checked")).toBe("true"));
  });

  it("locks the control during writes and keeps the actual value on failure", async () => {
    const user = userEvent.setup();
    let reject!: (reason: Error) => void;
    vi.mocked(bridge.setAutostartEnabled).mockReturnValue(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    render(<AutostartControl />);
    await waitFor(() => expect(checkbox().hasAttribute("disabled")).toBe(false));
    await user.click(checkbox());
    expect(checkbox().hasAttribute("disabled")).toBe(true);
    await act(async () => reject(new Error("access denied")));
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(checkbox().getAttribute("aria-checked")).toBe("true");
    expect(bridge.setAutostartEnabled).toHaveBeenCalledTimes(1);
  });

  it("allows retry after a read failure without writing a guessed value", async () => {
    const user = userEvent.setup();
    vi.mocked(bridge.autostartEnabled).mockRejectedValueOnce(new Error("read failed"));
    render(<AutostartControl />);
    expect(await screen.findByRole("alert")).toBeDefined();
    expect(checkbox().hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: /Повторить|Retry/ }));
    await waitFor(() => expect(checkbox().hasAttribute("disabled")).toBe(false));
    expect(bridge.setAutostartEnabled).not.toHaveBeenCalled();
  });
});
