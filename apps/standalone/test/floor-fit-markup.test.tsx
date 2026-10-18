import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { SwitchCard } from "../src/floor/kit/SwitchCard.js";
import { WorkstationSetup } from "../src/floor/setup/WorkstationSetup.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { manualRuntime, setUpPrinting } from "./support/printing.js";

/**
 * What the compact layouts of the terminal rely on in the markup (the measured proof is the browser
 * guard): a text that is cut short carries its full words as a `title`, and a button whose words are
 * hidden below 1100 px keeps them as its accessible name.
 */
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("the switch card", () => {
  it("carries its hint as the title of the line that is cut at two, and a plain-text detail likewise", () => {
    render(
      <SwitchCard
        title="С паллетами"
        hint="Короба идут на паллету: печатаются этикетки коробов и паллет."
        detail={<span>Шаблон: Дубликат</span>}
        detailTitle="Шаблон: Дубликат Data Matrix 40x30"
        checked
        stateLabel="Включено"
        onChange={vi.fn()}
      />,
    );
    const card = screen.getByRole("switch", { name: "С паллетами" });
    expect(
      within(card).getByText("Короба идут на паллету: печатаются этикетки коробов и паллет.").title,
    ).toBe("Короба идут на паллету: печатаются этикетки коробов и паллет.");
    expect(card.querySelector(".floor-switch-card__detail")?.getAttribute("title")).toBe(
      "Шаблон: Дубликат Data Matrix 40x30",
    );
  });

  it("has no title on a detail it was not given one for", () => {
    render(
      <SwitchCard
        title="Звук"
        detail="Коробов на паллете: 2"
        checked={false}
        stateLabel="Выключено"
        onChange={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("switch", { name: "Звук" })
        .querySelector(".floor-switch-card__detail")
        ?.hasAttribute("title"),
    ).toBe(false);
  });
});

function fakeSource() {
  let listener: ScanListener | null = null;
  const source: ScanSource = {
    start(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    clearPendingInput: () => undefined,
    setManualTextEntryActive: () => undefined,
  };
  return { source, read: (raw: string) => act(() => listener?.(raw)) };
}

describe("the printers' list of «Рабочее место»", () => {
  it("names each row's actions for a reader and gives the name and the line a title", async () => {
    const local = openLocalDb().executor;
    await setUpPrinting(local);
    const shell = fakeHardware();
    render(
      <ThemeProvider>
        <WorkstationSetup
          local={local}
          hardware={shell.hardware}
          printing={manualRuntime(shell.hardware).runtime}
          source={fakeSource().source}
          onSaved={vi.fn()}
          onBack={vi.fn()}
        />
      </ThemeProvider>,
    );
    const heading = await screen.findByRole("heading", { name: "Zebra у линии" });
    expect(heading.getAttribute("title")).toBe("Zebra у линии");
    const row = heading.closest("li") as HTMLElement;
    expect(row.querySelector(".setup-printer-row__connection")?.getAttribute("title")).toMatch(
      /192\.168\.1\.50/,
    );
    // The words are hidden by the stylesheet below 1100 px, so every action is also named by its aria-label.
    for (const [name, words] of [
      ["Пробная печать на «Zebra у линии»", "Пробная печать"],
      ["Изменить принтер «Zebra у линии»", "Изменить"],
    ] as const) {
      const button = within(row).getByRole("button", { name });
      expect(button.getAttribute("title")).toBe(words);
      expect(button.querySelector(".setup-row__action-text")?.textContent).toBe(words);
      expect(button.querySelector("svg")).not.toBeNull();
    }
  });
});
