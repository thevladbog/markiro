import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { KioskLayout } from "../src/ui/KioskLayout.js";

afterEach(cleanup);

describe("KioskLayout", () => {
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
