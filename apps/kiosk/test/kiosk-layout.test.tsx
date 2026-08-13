import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KioskLayout } from "../src/ui/KioskLayout.js";

afterEach(cleanup);

describe("KioskLayout", () => {
  it("bounds the document and cart screen to 100dvh without scrollable cart regions", () => {
    const css = readFileSync(`${process.cwd()}/src/kiosk.css`, "utf8");

    expect(css).toMatch(/html,[\s\S]*body,[\s\S]*#root[\s\S]*height:\s*100dvh/);
    expect(css).toMatch(/body,[\s\S]*#root[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.kiosk-cart[\s\S]*height:\s*100%[\s\S]*overflow:\s*hidden/);
    expect(css).toMatch(/\.kiosk-paged-lines__list[\s\S]*overflow:\s*hidden/);
    expect(css).not.toMatch(/\.kiosk-cart__list[\s\S]{0,100}overflow-y:\s*auto/);
  });

  it("defines approved portrait and landscape grids at the supported minima", () => {
    const css = readFileSync(`${process.cwd()}/src/kiosk.css`, "utf8");

    expect(css).toContain("grid-template-columns: minmax(0, 45fr) minmax(0, 55fr)");
    expect(css).toMatch(
      /@media \(orientation: portrait\)[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    );
    expect(css).toContain("--kiosk-cart-page-size: 5");
    expect(css).toContain("--kiosk-cart-page-size: 3");
  });
  it("keeps the status in shell flow and gives the screen its own bounded slot", () => {
    const { container } = render(
      <KioskLayout status={<div data-part="status">Status</div>}>
        <main data-part="screen">Screen</main>
      </KioskLayout>,
    );

    const shell = container.firstElementChild;
    const slot = container.querySelector(".kiosk-screen-slot");

    expect(shell?.classList.contains("kiosk-shell")).toBe(true);
    expect(shell?.children).toHaveLength(2);
    expect(shell?.firstElementChild?.getAttribute("data-part")).toBe("status");
    expect(slot?.parentElement).toBe(shell);
    expect(slot?.firstElementChild?.getAttribute("data-part")).toBe("screen");
  });

  it("omits the status row without changing the bounded screen slot", () => {
    const { container } = render(
      <KioskLayout>
        <main>Screen</main>
      </KioskLayout>,
    );

    const shell = container.querySelector(".kiosk-shell");
    expect(shell?.children).toHaveLength(1);
    expect(shell?.firstElementChild?.classList.contains("kiosk-screen-slot")).toBe(true);
  });
});
