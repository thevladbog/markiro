import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PairingCodeReveal } from "../src/pages/kiosks/PairingCodeReveal.js";
import {
  PAIRING_BARCODE_HEIGHT,
  PAIRING_BARCODE_WIDTH,
} from "../src/pages/kiosks/pairingBarcodeBox.js";

/**
 * Pins the barcode chunk in its pending state for the whole file. What the
 * placeholder exists for is the window *before* bwip-js lands -- ~300ms in
 * production, but a single microtask once vitest has the module cached, which
 * would make a timing-based assertion order-dependent and flaky. Throwing a
 * promise that never settles keeps the Suspense boundary in its fallback, so
 * the assertions below are deterministic. `kiosks.test.tsx` covers the
 * resolved side with the real module.
 */
vi.mock("../src/pages/kiosks/PairingBarcode.js", () => ({
  default: () => {
    throw new Promise<never>(() => {});
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PAIRING_TTL_MS = 15 * 60_000;

function renderReveal() {
  return render(
    <PairingCodeReveal
      code="12345678"
      expiresAt={new Date(Date.now() + PAIRING_TTL_MS).toISOString()}
      regenerating={false}
      onRegenerate={() => {}}
      onExpired={() => {}}
    />,
  );
}

describe("pairing code barcode placeholder", () => {
  it("reserves the barcode's exact box while the chunk is still loading", async () => {
    renderReveal();

    const label = await screen.findByText("Загрузка штрихкода…");
    const box = label.closest("[aria-busy='true']");

    // Same dimensions the loaded barcode occupies (`pairingBarcodeBoxStyle` is
    // shared by both), so the swap cannot shift the digits or the countdown.
    expect(box).not.toBeNull();
    expect((box as HTMLElement).style.width).toBe(`${PAIRING_BARCODE_WIDTH}px`);
    expect((box as HTMLElement).style.height).toBe(`${PAIRING_BARCODE_HEIGHT}px`);
  });

  it("keeps the digits and the countdown usable while the barcode is pending", async () => {
    renderReveal();
    await screen.findByText("Загрузка штрихкода…");

    // The barcode is a convenience on top of the code, never a gate on it --
    // a slow chunk must not hold back the parts the operator can already act on.
    expect(screen.getByText("1234 5678")).toBeDefined();
    expect(screen.getByRole("button", { name: "Скопировать" })).toBeDefined();
  });

  it("reports expiry again when the reveal receives a new expiration", async () => {
    vi.useFakeTimers();
    const onExpired = vi.fn();
    const firstExpiry = new Date(Date.now() + 1_000).toISOString();
    const view = render(
      <PairingCodeReveal
        code="12345678"
        expiresAt={firstExpiry}
        regenerating={false}
        onRegenerate={() => {}}
        onExpired={onExpired}
      />,
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(onExpired).toHaveBeenCalledTimes(1);

    view.rerender(
      <PairingCodeReveal
        code="87654321"
        expiresAt={new Date(Date.now() + 1_000).toISOString()}
        regenerating={false}
        onRegenerate={() => {}}
        onExpired={onExpired}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(onExpired).toHaveBeenCalledTimes(2);
  });
});
