import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSscc } from "@markiro/domain";
import type { ScanListener, ScanSource } from "../src/lib/scan-source.js";
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

describe("PrintVerification", () => {
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
});
