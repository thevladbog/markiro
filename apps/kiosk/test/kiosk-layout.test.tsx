import { readFileSync } from "node:fs";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KioskLayout, supportsKioskViewport } from "../src/ui/KioskLayout.js";
import { StatusStrip } from "../src/ui/StatusStrip.js";
import { Pairing } from "../src/screens/Pairing.js";

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
});

describe("KioskLayout", () => {
  it("accepts both exact kiosk minima and rejects a viewport below both", () => {
    expect(supportsKioskViewport(480, 800)).toBe(true);
    expect(supportsKioskViewport(800, 480)).toBe(true);
    expect(supportsKioskViewport(479, 799)).toBe(false);
    expect(supportsKioskViewport(799, 479)).toBe(false);
  });

  it("replaces the active flow with a bounded diagnostic below the supported minima", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 479 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 799 });

    render(
      <KioskLayout status={<div>status</div>}>
        <main>Active flow</main>
      </KioskLayout>,
    );

    expect(screen.getByRole("heading", { name: "Экран устройства слишком мал" })).toBeDefined();
    expect(screen.getByText("479 × 799")).toBeDefined();
    expect(screen.queryByText("Active flow")).toBeNull();
    expect(screen.queryByText("status")).toBeNull();

    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 480 });
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByText("Active flow")).toBeDefined();
  });

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
    expect(css).toMatch(
      /@media \(orientation: portrait\)[\s\S]*?\.kiosk-pairing\s*{[\s\S]*?--control-keypad:\s*64px/,
    );
    expect(css).toMatch(
      /@media \(orientation: landscape\) and \(max-height: 540px\)[\s\S]*?\.kiosk-pairing\s*{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) minmax\(280px, 0\.8fr\)/,
    );
    expect(css).toMatch(/\.kiosk-pairing__details\s*{[\s\S]*?overflow:\s*hidden/);
  });

  it("uses the shared floor-sized Button contract for the pairing scan action", () => {
    render(
      <Pairing
        defaultServerUrl="https://markiro.test"
        subscribe={() => () => undefined}
        onPaired={() => undefined}
        onConfigureScanner={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Сканировать код" }).style.minHeight).toBe(
      "var(--control-floor)",
    );
  });

  it("keeps the worst persistent status in one fixed bounded row", () => {
    const { container } = render(
      <KioskLayout
        status={
          <StatusStrip
            online={false}
            age="blocked"
            ageMs={9 * 24 * 60 * 60 * 1_000}
            quarantined={99}
          />
        }
      >
        <main>Screen</main>
      </KioskLayout>,
    );

    const strip = container.querySelector(".kiosk-status-strip");
    expect(strip?.children).toHaveLength(3);
    expect(strip?.getAttribute("aria-label")).toContain("Нет связи");
    expect(strip?.getAttribute("aria-label")).toContain("9 сут");
    expect(strip?.getAttribute("aria-label")).toContain("99");

    const css = readFileSync(`${process.cwd()}/src/kiosk.css`, "utf8");
    expect(css).toMatch(/\.kiosk-status-strip\s*{[\s\S]*?height:\s*61px/);
    expect(css).toMatch(/\.kiosk-status-strip\s*{[\s\S]*?flex-wrap:\s*nowrap/);
    expect(css).toMatch(/\.kiosk-status-strip\s*{[\s\S]*?overflow:\s*hidden/);
    expect(css).toMatch(/\.kiosk-status-strip\s+\.mk-chip\s*{[\s\S]*?min-width:\s*0/);
    expect(css).toMatch(/\.kiosk-status-strip\s+\.mk-chip\s*{[\s\S]*?text-overflow:\s*ellipsis/);
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
