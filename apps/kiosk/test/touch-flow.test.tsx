import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Done } from "../src/screens/Done.js";
import { OperationChoice } from "../src/screens/OperationChoice.js";

afterEach(cleanup);

describe("touch-flow acceptance contracts", () => {
  it("keeps semantic outcome copy next to the non-colour status treatment", () => {
    const { container } = render(
      <Done
        result={{
          orderNo: "ORD-26-42",
          status: "pending",
          itemCount: 1,
          conflicts: [],
        }}
        cart={{
          reason: "buy",
          lines: [
            {
              kind: "km",
              rawKm: "raw",
              kmKey: "key",
              gtin14: "04600682000013",
              serial: "SERIAL",
              productId: "33333333-3333-4333-8333-333333333333",
              name: "Молоко",
              unitPrice: "89.90",
              bottleCount: 1,
            },
          ],
        }}
        showPrices
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain("Подтверждено сервером");
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it("keeps the linear focus order back, cancel, then the two operation choices", () => {
    render(
      <OperationChoice writeoffAvailable onChoose={vi.fn()} onBack={vi.fn()} onCancel={vi.fn()} />,
    );

    expect(screen.getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "Назад",
      "Отменить операцию",
      expect.stringContaining("Через кассу"),
      expect.stringContaining("Списание"),
    ]);
  });

  it("removes motion as well as animation when the device asks for reduced motion", () => {
    const css = readFileSync(`${process.cwd()}/src/kiosk.css`, "utf8");
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const end = css.indexOf(".kiosk-pairing__service", start);
    const reduced = css.slice(start, end);

    expect(reduced).toContain(".kiosk-control");
    expect(reduced).toMatch(/transition:\s*none\s*!important/);
    expect(reduced).toMatch(/\.badge-scan-animation__beam[\s\S]*transform:/);
  });

  it("keeps the outcome acknowledgement at the touch floor in a low landscape viewport", () => {
    const css = readFileSync(`${process.cwd()}/src/kiosk.css`, "utf8");

    expect(css).toMatch(
      /\.kiosk-done\s*>\s*\.kiosk-control\s*{[\s\S]*?flex:\s*0 0 auto[\s\S]*?min-height:\s*48px/,
    );
    expect(css).toMatch(
      /@media \(orientation: landscape\) and \(max-height: 540px\)[\s\S]*?\.kiosk-done\s*>\s*svg\s*{[\s\S]*?height:\s*40px/,
    );
  });

  it("bounds refusal details without a nested scroll region", () => {
    render(
      <Done
        result={{
          orderNo: "ORD-26-42",
          status: "pending",
          itemCount: 1,
          conflicts: [
            { rawKm: "raw-1", reason: "duplicate" },
            { rawKm: "raw-2", reason: "over_limit" },
            { rawKm: "raw-3", reason: "not_allowed" },
          ],
          boxConflicts: [],
          acceptedBoxes: [],
        }}
        cart={{ reason: "buy", lines: [] }}
        showPrices={false}
        onReset={vi.fn()}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.querySelectorAll("li")).toHaveLength(2);
    expect(alert.textContent).toContain("Ещё отказов: 1");

    const css = readFileSync(`${process.cwd()}/src/kiosk.css`, "utf8");
    const conflictRule = css.match(/\.kiosk-done__conflicts\s*{([^}]*)}/)?.[1];
    expect(conflictRule).toContain("overflow: hidden");
    expect(conflictRule).not.toContain("overflow-y: auto");
  });
});
