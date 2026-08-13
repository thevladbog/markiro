import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildSscc } from "@markiro/domain";
import {
  createKeyboardWedgeSource,
  type ScanListener,
  type ScanSource,
} from "../src/lib/scan-source.js";
import { PrintVerification } from "../src/ui/PrintVerification.js";

// This test file never touches `i18n.changeLanguage` -- the station's i18n
// singleton (src/i18n/index.ts) defaults to "ru", which is what lets the
// Russian copy below be asserted directly, exactly as it renders on a real
// floor terminal.

// A real, check-digit-valid 18-digit SSCC (see @markiro/domain's own
// sscc.test.ts fixture) -- and a second, distinct one for the mismatch case.
const SSCC = buildSscc(0, "460123456", 1);
const OTHER_SSCC = buildSscc(0, "460123456", 2);

/** A source the test drives directly, same shape as work-screen.test.tsx's. */
function manualSource(): ScanSource & { emit: ScanListener } {
  let listener: ScanListener = () => {};
  return {
    start(l) {
      listener = l;
      return () => {
        listener = () => {};
      };
    },
    emit: (raw) => listener(raw),
  };
}

function VerificationHarness({
  scanSource = manualSource(),
  onSkip = () => undefined,
  onReprint = () => undefined,
}: {
  scanSource?: ScanSource;
  onSkip?: () => void;
  onReprint?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Verify printed label
      </button>
      {open ? (
        <PrintVerification
          expected={SSCC}
          onVerified={() => setOpen(false)}
          onReprint={onReprint}
          onSkip={() => {
            onSkip();
            setOpen(false);
          }}
          scanSource={scanSource}
        />
      ) : null}
    </>
  );
}

describe("PrintVerification", () => {
  it("moves focus inside, traps both tab directions, and restores the surviving opener on skip", () => {
    const onSkip = vi.fn();
    render(<VerificationHarness onSkip={onSkip} />);
    const opener = screen.getByRole("button", { name: "Verify printed label" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Отсканируйте распечатанную этикетку" });
    const skip = screen.getByRole("button", { name: "Пропустить" });
    const reprint = screen.getByRole("button", { name: "Печатать заново" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(reprint);
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(skip);
    reprint.focus();
    fireEvent.keyDown(reprint, { key: "Tab" });
    expect(document.activeElement).toBe(skip);
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.click(skip);
    expect(onSkip).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
  });

  it("unmounts safely when the element that had focus no longer survives", () => {
    const formerFocus = document.createElement("button");
    document.body.append(formerFocus);
    formerFocus.focus();
    const view = render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={manualSource()}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("dialog", { name: "Отсканируйте распечатанную этикетку" }),
    );
    formerFocus.remove();
    expect(() => view.unmount()).not.toThrow();
  });

  it("does not activate a focused action with the terminating Enter from a HID scan", async () => {
    const source = createKeyboardWedgeSource(window);
    const onSkip = vi.fn();
    const onReprint = vi.fn();
    render(<VerificationHarness scanSource={source} onSkip={onSkip} onReprint={onReprint} />);
    const opener = screen.getByRole("button", { name: "Verify printed label" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Отсканируйте распечатанную этикетку" });
    expect(document.activeElement).toBe(dialog);

    for (const key of `]C100${OTHER_SSCC}`) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    expect(window.dispatchEvent(enter)).toBe(false);

    await screen.findByText("Это другая этикетка");
    expect(onSkip).not.toHaveBeenCalled();
    expect(onReprint).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(dialog);
  });

  it("accepts a scan of the expected label", async () => {
    const source = manualSource();
    const onVerified = vi.fn();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={onVerified}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    act(() => source.emit(`]C100${SSCC}`));
    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
  });

  it("resolves only once when two matching scans arrive before persistence finishes", async () => {
    const source = manualSource();
    const onVerified = vi.fn(() => new Promise<void>(() => {}));
    const onSkip = vi.fn();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={onVerified}
        onReprint={vi.fn()}
        onSkip={onSkip}
        scanSource={source}
      />,
    );

    act(() => {
      source.emit(`]C100${SSCC}`);
      source.emit(`]C100${SSCC}`);
    });

    expect(onVerified).toHaveBeenCalledOnce();
    expect(onSkip).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Пропустить" })).toHaveProperty("disabled", true);
  });

  it("does not let skip race a matching scan that already started resolution", () => {
    const source = manualSource();
    const onVerified = vi.fn(() => new Promise<void>(() => {}));
    const onSkip = vi.fn();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={onVerified}
        onReprint={vi.fn()}
        onSkip={onSkip}
        scanSource={source}
      />,
    );

    act(() => source.emit(`]C100${SSCC}`));
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));

    expect(onVerified).toHaveBeenCalledOnce();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("starts a fresh single-flight scan resolution for the next expected label", async () => {
    const source = manualSource();
    const onVerified = vi.fn(async () => true);
    const onSkip = vi.fn(async () => true);
    const view = render(
      <PrintVerification
        expected={SSCC}
        onVerified={onVerified}
        onReprint={vi.fn()}
        onSkip={onSkip}
        scanSource={source}
      />,
    );

    act(() => {
      source.emit(`]C100${SSCC}`);
      source.emit(`]C100${SSCC}`);
    });
    await waitFor(() => expect(onVerified).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Пропустить" })).toHaveProperty("disabled", true);

    view.rerender(
      <PrintVerification
        expected={OTHER_SSCC}
        onVerified={onVerified}
        onReprint={vi.fn()}
        onSkip={onSkip}
        scanSource={source}
      />,
    );
    expect(screen.getByText(OTHER_SSCC)).toBeDefined();
    expect(screen.getByRole("button", { name: "Пропустить" })).toHaveProperty("disabled", false);

    act(() => {
      source.emit(`]C100${OTHER_SSCC}`);
      source.emit(`]C100${OTHER_SSCC}`);
    });
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(2));
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("starts a fresh single-flight skip resolution for the next expected label", async () => {
    const source = manualSource();
    const onSkip = vi.fn(async () => true);
    const view = render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={onSkip}
        scanSource={source}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    await waitFor(() => expect(onSkip).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Пропустить" })).toHaveProperty("disabled", true);

    view.rerender(
      <PrintVerification
        expected={OTHER_SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={onSkip}
        scanSource={source}
      />,
    );
    const nextSkip = screen.getByRole("button", { name: "Пропустить" });
    expect(nextSkip).toHaveProperty("disabled", false);

    fireEvent.click(nextSkip);
    fireEvent.click(nextSkip);
    await waitFor(() => expect(onSkip).toHaveBeenCalledTimes(2));
  });

  it("does not accept a scan of a different label", async () => {
    const source = manualSource();
    const onVerified = vi.fn();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={onVerified}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    act(() => source.emit(`00${OTHER_SSCC}`));
    await waitFor(() => expect(screen.getByText("Это другая этикетка")).toBeDefined());
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("ignores a scan that is not an SSCC at all", async () => {
    const source = manualSource();
    const onVerified = vi.fn();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={onVerified}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    act(() => source.emit("0104601234567890215Abc"));
    await waitFor(() => expect(screen.getByText("Это не групповой код")).toBeDefined());
    expect(onVerified).not.toHaveBeenCalled();
  });

  it("always offers a way out", () => {
    const source = manualSource();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    expect(screen.getByRole("button", { name: "Печатать заново" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Пропустить" })).toBeDefined();
  });

  it("gives both exits floor-sized targets and text", () => {
    const source = manualSource();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    for (const name of ["Печатать заново", "Пропустить"]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).toContain("mk-btn--floor");
      expect(button.style.height).toBe("var(--control-floor)");
      expect(button.style.fontSize).toBe("18px");
    }
  });

  // Self-review: the brief's own tests only check that both exits are
  // PRESENT, which a button with no onClick handler at all would still
  // pass. These two pin that pressing each one actually reaches the
  // caller -- the real "always has an exit" guarantee.
  it("calls onReprint when the reprint button is pressed", () => {
    const source = manualSource();
    const onReprint = vi.fn();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={onReprint}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Печатать заново" }));
    expect(onReprint).toHaveBeenCalledOnce();
  });

  it("shows a sanitized classified failure returned by reprint", async () => {
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={() => Promise.resolve("transport_failed")}
        onSkip={vi.fn()}
        scanSource={manualSource()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Печатать заново" }));

    expect(await screen.findByText("Принтер не принял задание")).toBeDefined();
  });

  it("calls onSkip when the skip button is pressed", () => {
    const source = manualSource();
    const onSkip = vi.fn();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={onSkip}
        scanSource={source}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(onSkip).toHaveBeenCalledOnce();
  });

  it("still offers both exits after a mismatch is shown", async () => {
    // Guards against a plausible bug: hiding or disabling the exits while a
    // mismatch message is displayed, which would strand the operator right
    // when they most need a way out.
    const source = manualSource();
    render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    act(() => source.emit(`00${OTHER_SSCC}`));
    await waitFor(() => expect(screen.getByText("Это другая этикетка")).toBeDefined());
    expect(screen.getByRole("button", { name: "Печатать заново" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Пропустить" })).toBeDefined();
  });

  it("does not carry a mismatch into the next expected label", async () => {
    const source = manualSource();
    const view = render(
      <PrintVerification
        expected={SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );
    act(() => source.emit(`00${OTHER_SSCC}`));
    await screen.findByText("Это другая этикетка");

    view.rerender(
      <PrintVerification
        expected={OTHER_SSCC}
        onVerified={vi.fn()}
        onReprint={vi.fn()}
        onSkip={vi.fn()}
        scanSource={source}
      />,
    );

    expect(screen.queryByText("Это другая этикетка")).toBeNull();
    expect(screen.getByText(OTHER_SSCC)).toBeDefined();
  });
});
