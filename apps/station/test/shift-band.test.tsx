import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { hueFromGtin, primeAccentHue } from "../src/lib/product-accent.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { ShiftTotalView } from "../src/lib/shift-progress.js";
import { ShiftBand, productMonogram } from "../src/ui/work/ShiftBand.js";

const labels = {
  gtin: "GTIN",
  counterpartyPrefix: "for:",
  totalAll: "In shift · all terminals",
  totalTerminal: "In shift · this terminal",
  planPercent: (percent: string) => `${percent} of plan`,
  terminalShare: (value: string) => `this terminal ${value}`,
  othersAsOf: (time: string) => `other terminals as of ${time}`,
};

const terminalOnly: ShiftTotalView = {
  scope: "terminal",
  total: 302,
  planned: null,
  planRatio: null,
  terminal: null,
  othersAsOf: null,
};

describe("ShiftBand", () => {
  it("names the product, prints GTIN and customer chips and the local total", () => {
    const { container } = render(
      <ShiftBand
        productName="Widget"
        counterpartyName="Plant North"
        gtin="04607000000042"
        total={terminalOnly}
        locale="en-US"
        labels={labels}
      />,
    );
    expect(screen.getByRole("heading", { name: "Widget" })).toBeDefined();
    const chips = [...container.querySelectorAll(".work-shift-band__chip")].map(
      (chip) => chip.textContent,
    );
    expect(chips).toEqual(["GTIN 04607000000042", "for: Plant North"]);
    expect(screen.getByText("In shift · this terminal")).toBeDefined();
    expect(screen.getByTestId("shift-total").textContent).toBe("302");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows every terminal against the plan with this terminal's share", () => {
    render(
      <ShiftBand
        productName="Widget"
        counterpartyName={null}
        total={{
          scope: "all",
          total: 1302,
          planned: 9580,
          planRatio: 1302 / 9580,
          terminal: 302,
          othersAsOf: null,
        }}
        locale="en-US"
        labels={labels}
      />,
    );
    expect(screen.getByText("In shift · all terminals")).toBeDefined();
    expect(screen.getByTestId("shift-total").textContent).toBe("1,302");
    expect(screen.getByText("/ 9,580")).toBeDefined();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("1302");
    expect(bar.getAttribute("aria-valuemax")).toBe("9580");
    expect(screen.getByText("14% of plan · this terminal 302")).toBeDefined();
  });

  it("replaces the share with the age of a stale answer", () => {
    const { container } = render(
      <ShiftBand
        productName="Widget"
        counterpartyName={null}
        total={{
          scope: "all",
          total: 1302,
          planned: null,
          planRatio: null,
          terminal: 302,
          othersAsOf: "2026-09-25T08:55:00.000Z",
        }}
        locale="en-US"
        labels={labels}
      />,
    );
    expect(container.querySelector(".work-shift-band__meta")?.textContent).toMatch(
      /^other terminals as of /,
    );
  });

  it("seeds the accent from the GTIN and falls back to a monogram without a photo", () => {
    const { container, rerender } = render(
      <ShiftBand
        productName="Ягодный морс"
        counterpartyName={null}
        total={terminalOnly}
        locale="ru-RU"
        labels={labels}
      />,
    );
    const band = () => container.querySelector<HTMLElement>(".work-shift-band");
    expect(band()?.getAttribute("data-accent")).toBeNull();
    expect(container.querySelector(".work-shift-band__monogram")?.textContent).toBe("Я");
    rerender(
      <ShiftBand
        productName="Ягодный морс"
        counterpartyName={null}
        gtin="04607000000042"
        total={terminalOnly}
        locale="ru-RU"
        labels={labels}
      />,
    );
    expect(band()?.getAttribute("data-accent")).toBe("true");
    expect(band()?.style.getPropertyValue("--product-hue")).toBe(
      String(hueFromGtin("04607000000042")),
    );
  });

  it("never reuses one image's extracted hue for another image", () => {
    const exec: SqlExecutor = { run: async () => undefined, all: async () => [] };
    const imageOf = (checksum: string) => ({
      checksum,
      contentType: "image/webp" as const,
      byteSize: 1,
      width: 1,
      height: 1,
    });
    primeAccentHue("band-accent-a", 200);
    const props = {
      productName: "Widget",
      counterpartyName: null,
      exec,
      productId: "p1",
      total: terminalOnly,
      locale: "en-US",
      labels,
    };
    const { container, rerender } = render(
      <ShiftBand {...props} image={imageOf("band-accent-a")} />,
    );
    const band = () => container.querySelector<HTMLElement>(".work-shift-band");
    expect(band()?.style.getPropertyValue("--product-hue")).toBe("200");
    rerender(<ShiftBand {...props} image={imageOf("band-accent-b")} />);
    expect(band()?.getAttribute("data-accent")).toBeNull();
  });

  it("derives a first-letter monogram", () => {
    expect(productMonogram("«Балтика 7»")).toBe("Б");
    expect(productMonogram("  ")).toBe("?");
  });
});
