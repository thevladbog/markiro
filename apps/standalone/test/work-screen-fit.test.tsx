import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  cellBox,
  cellSerialPlan,
  serialForCell,
  type CellSerialInput,
} from "../src/floor/work/box-cells.js";
import { alphaOfSample, photoBacking, type PhotoAlpha } from "../src/floor/shifts/photo-backing.js";
import { ScanCode } from "../src/floor/work/ScanCode.js";
import { ScanHistory, wholeRowsThatFit } from "../src/floor/work/ScanHistory.js";
import { codeDisplay, type ScanHistoryRow } from "../src/floor/work/scan-history.js";
import { ShiftBand, buildBoxCells } from "../src/floor/work/WorkInstruments.js";

/**
 * The work screen's fit on the real terminal (owner photo, 2026-10-16): the box buttons, the
 * history's whole rows, the serial in the code lines and in the box's cells, and the photo's
 * backing. The pixel measurement itself is `test/harness/work-fit/measure.mjs` (a browser).
 */
const APP = process.cwd();
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (path: string) => strip(readFileSync(join(APP, path), "utf8"));
const WORK = read("src/floor/work/work-screen.css");
const HISTORY = read("src/floor/work/scan-history.css");
const BACKING = read("src/floor/shifts/photo-backing.css");

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the code line: the serial (AI 21) first", () => {
  it("shows the whole serial and the GTIN short, and keeps the whole code for the title", () => {
    expect(codeDisplay("04680089900017", "2L=o8Zk3VqXp1")).toEqual({
      serial: "2L=o8Zk3VqXp1",
      gtin: "…900017",
      full: "04680089900017 2L=o8Zk3VqXp1",
    });
  });

  it("cuts the head of a long serial, never its end", () => {
    const shown = codeDisplay("04680089900017", "ABCDEFGHIJKLMNOPQRST");
    expect(shown?.serial).toBe("…HIJKLMNOPQRST");
    expect(shown?.serial).toHaveLength(14);
    expect(codeDisplay("04680089900017", "ABCDEFGHIJKLMNOPQRST", 20)?.serial).toBe(
      "ABCDEFGHIJKLMNOPQRST",
    );
  });

  it("keeps a serial with GS1-looking characters whole, as the scan pipeline stored it", () => {
    // `serial` is the value of AI 21 that the shared parser cut before the crypto tail (AI 91/92
    // after a group separator); nothing after it is stored, so nothing of the tail can show.
    expect(codeDisplay("04680089900017", "kP3x/ZaR5vY8")?.serial).toBe("kP3x/ZaR5vY8");
  });

  it("answers null without a serial, and the caller keeps its old line", () => {
    expect(codeDisplay("04680089900017", null)).toBeNull();
    expect(codeDisplay(null, "")).toBeNull();
    render(<ScanCode gtin14={null} serial={null} fallback="не код маркировки" />);
    expect(screen.getByText("не код маркировки")).toBeTruthy();
  });

  it("renders the serial as the main part with the whole code in its title", () => {
    render(<ScanCode gtin14="04680089900017" serial="2L=o8Zk3VqXp1" fallback="x" />);
    const code = document.querySelector(".scan-code");
    expect(code?.getAttribute("title")).toBe("04680089900017 2L=o8Zk3VqXp1");
    expect(code?.querySelector(".scan-code__serial")?.textContent).toBe("2L=o8Zk3VqXp1");
    expect(code?.querySelector(".scan-code__gtin")?.textContent).toBe("GTIN …900017");
  });
});

describe("the history shows whole rows only", () => {
  it("counts the rows that fit whole", () => {
    expect(wholeRowsThatFit(296, 56, 4)).toBe(5);
    expect(wholeRowsThatFit(287, 56, 4)).toBe(4);
    expect(wholeRowsThatFit(79, 56, 4)).toBe(1);
    expect(wholeRowsThatFit(55, 56, 4)).toBe(0);
    expect(wholeRowsThatFit(0, 56, 4)).toBe(0);
    expect(wholeRowsThatFit(100, 0, 4)).toBe(0);
  });

  const rows: ScanHistoryRow[] = Array.from({ length: 8 }, (_, index) => ({
    id: `r${index}`,
    scannedAt: `2026-10-16T09:00:0${index}.000Z`,
    verdict: "ok",
    duplicateSource: null,
    operatorName: null,
    boxPosition: index + 1,
    maskedCode: `04680089900017 …${index}`,
    gtin14: "04680089900017",
    serial: `SER${index}`,
  }));

  it("renders only the rows the list's box holds and says the rest is in «Вся история»", () => {
    // A 130 px list of 56 px rows: two whole rows, the third would be cut.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(130);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(56);
    render(
      <ThemeProvider>
        <ScanHistory read={{ kind: "ready", rows, total: 40 }} onOpenAll={() => undefined} />
      </ThemeProvider>,
    );
    const list = screen.getByRole("list", { name: "История сканирований" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/Показаны последние записи/)).toBeTruthy();
  });

  it("shows every row where no layout exists (a test's DOM)", () => {
    render(
      <ThemeProvider>
        <ScanHistory read={{ kind: "ready", rows, total: 8 }} onOpenAll={() => undefined} />
      </ThemeProvider>,
    );
    expect(
      within(screen.getByRole("list", { name: "История сканирований" })).getAllByRole("listitem"),
    ).toHaveLength(8);
  });

  it("clips what is left over and is a flexible grid row, so no row is ever cut by the panel", () => {
    expect(rule(HISTORY, ".scan-history--compact .scan-history__list")).toMatch(
      /overflow:\s*hidden/,
    );
    expect(rule(HISTORY, ".scan-history--compact .scan-history__list")).toMatch(/min-height:\s*0/);
    expect(rule(HISTORY, ".scan-history--compact")).toMatch(
      /grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/,
    );
  });
});

describe("the open box's buttons", () => {
  it("are one height of at least 64 px, centred, two lines at most, never cut", () => {
    const actions = rule(WORK, ".work-box-fill__actions");
    expect(actions).toMatch(/align-items:\s*stretch/);
    const button = rule(WORK, ".work-box-fill__actions .mk-btn");
    expect(button).toMatch(/height:\s*auto\s*!important/);
    expect(button).toMatch(/min-height:\s*64px\s*!important/);
    expect(button).toMatch(/line-height:\s*24px\s*!important/);
    expect(button).toMatch(/text-align:\s*center/);
    expect(button).toMatch(/white-space:\s*normal/);
    expect(button).toMatch(/overflow-wrap:\s*normal/);
  });

  it("puts the title on the left of the header and the counter on its right edge", () => {
    const head = rule(WORK, ".work-box-fill__head");
    expect(head).toMatch(/justify-content:\s*space-between/);
    expect(head).toMatch(/flex-wrap:\s*nowrap/);
    expect(head).toMatch(/align-items:\s*baseline/);
    expect(rule(WORK, ".work-box-fill__count")).toMatch(/margin-inline-start:\s*auto/);
  });
});

describe("the serial in a box's cells is decided by the cell's computed size", () => {
  const SERIAL = 20; // the longest a GS1 serial is
  const GAP = 8;
  /** The box column's grid at 1280 px: 640 wide; its height is the window's less the rest. */
  const GRID = {
    "1280x1024": { width: 640, height: 489 },
    "1280x800": { width: 640, height: 281 },
  } as const;
  const plan = (capacity: number, size: keyof typeof GRID, serialLength = SERIAL) => {
    const large = capacity <= 10;
    const input: CellSerialInput = {
      ...GRID[size],
      columns: large ? capacity : 10,
      rows: large ? 1 : Math.ceil(capacity / 10),
      gap: large ? GAP : 5,
      serialLength,
      numbered: large,
    };
    return cellSerialPlan(input);
  };

  it("shows it whole in a wide cell (3 places) and cut from the head in a narrower one (6)", () => {
    for (const size of ["1280x1024", "1280x800"] as const) {
      const three = plan(3, size);
      expect(three.show).toBe(true);
      if (three.show) {
        expect(three.fontPx).toBeGreaterThanOrEqual(12);
        expect(three.chars).toBe(SERIAL);
      }
      const six = plan(6, size);
      expect(six.show).toBe(true);
      if (six.show) {
        expect(six.chars).toBeLessThan(SERIAL);
        // A cut serial spends one character on the «…»; at least six of its last remain.
        expect(six.chars - 1).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it("hides it where the cell is too narrow for six readable characters (10), and where cells carry no number (12, 24, 48)", () => {
    for (const size of ["1280x1024", "1280x800"] as const) {
      expect(plan(10, size).show).toBe(false);
      for (const capacity of [12, 24, 48]) expect(plan(capacity, size).show).toBe(false);
    }
  });

  it("hides it in a cell too low for the number and a line of serial", () => {
    expect(
      cellSerialPlan({
        width: 640,
        height: 60,
        columns: 3,
        rows: 1,
        gap: GAP,
        serialLength: SERIAL,
        numbered: true,
      }).show,
    ).toBe(false);
  });

  it("needs only the serial's own length: a short serial fits a narrow cell whole", () => {
    expect(plan(10, "1280x1024", 4).show).toBe(true);
  });

  it("never shows a serial with nothing to show or no layout", () => {
    expect(plan(3, "1280x1024", 0).show).toBe(false);
    expect(
      cellSerialPlan({
        width: 0,
        height: 0,
        columns: 3,
        rows: 1,
        gap: 8,
        serialLength: 9,
        numbered: true,
      }).show,
    ).toBe(false);
  });

  it("computes a cell's box from the grid minus its gaps", () => {
    expect(cellBox({ width: 640, height: 300, columns: 3, rows: 1, gap: 8 })).toEqual({
      width: (640 - 16) / 3,
      height: 300,
    });
  });

  it("cuts a serial from its head to the cell's characters", () => {
    expect(serialForCell("2L=o8Zk3VqXp1", 13)).toBe("2L=o8Zk3VqXp1");
    expect(serialForCell("2L=o8Zk3VqXp1", 9)).toBe("…Zk3VqXp1");
  });

  it("builds the cells the plan is about: one a place up to ten", () => {
    expect(buildBoxCells(1, 3).map((cell) => cell.state)).toEqual(["filled", "next", "empty"]);
  });
});

describe("the backing of a product's photo", () => {
  const cases: [string, Parameters<typeof photoBacking>[0], PhotoAlpha, string][] = [
    ["no photo (the monogram)", null, null, "gradient"],
    ["a transparent PNG", "image/png", "transparent", "gradient"],
    ["a transparent WebP", "image/webp", "transparent", "gradient"],
    ["a PNG not read yet", "image/png", null, "gradient"],
    ["an opaque PNG", "image/png", "opaque", "none"],
    ["an opaque WebP", "image/webp", "opaque", "none"],
    ["a JPEG, whatever the pixels say", "image/jpeg", null, "none"],
    ["a JPEG read as transparent", "image/jpeg", "transparent", "none"],
  ];
  it.each(cases)("%s", (_name, mediaType, alpha, expected) => {
    expect(photoBacking(mediaType, alpha)).toBe(expected);
  });

  const side = 16;
  /** RGBA of a 16x16 sample whose border ring has `alpha` and whose middle is opaque. */
  const sample = (alpha: number) => {
    const data = new Uint8ClampedArray(side * side * 4);
    for (let pixel = 0; pixel < side * side; pixel += 1) {
      const column = pixel % side;
      const row = (pixel - column) / side;
      const ring = column === 0 || row === 0 || column === side - 1 || row === side - 1;
      data[pixel * 4 + 3] = ring ? alpha : 255;
    }
    return data;
  };
  it("reads the border ring's alpha: transparent round a cut-out, opaque round a studio shot", () => {
    expect(alphaOfSample(sample(0))).toBe("transparent");
    expect(alphaOfSample(sample(255))).toBe("opaque");
  });

  it("the band's photo without a stored photo stands on the brand gradient", () => {
    render(
      <ThemeProvider>
        <ShiftBand
          productName="Сидр"
          gtin="04680089900017"
          number="№ 12"
          counterpartyName={null}
          accepted={0}
          plannedQty={null}
          modeLabel="Агрегация"
        />
      </ThemeProvider>,
    );
    const photo = document.querySelector(".work-shift-band__photo");
    expect(photo?.getAttribute("data-photo-backing")).toBe("gradient");
  });

  it("paints the brand gradient or nothing, from the one stylesheet every frame uses", () => {
    const gradient = rule(
      BACKING,
      ':where(.floor-frame, .station-screen) [data-photo-backing="gradient"]',
    );
    expect(gradient).toMatch(
      /linear-gradient\(305deg,\s*var\(--brand1\),\s*var\(--brand2\) 55%,\s*var\(--brand3\)\)/,
    );
    expect(gradient).toMatch(/border-color:\s*var\(--brandline\)/);
    expect(
      rule(BACKING, ':where(.floor-frame, .station-screen) [data-photo-backing="none"]'),
    ).toMatch(/background:\s*transparent/);
    // No frame paints its own flat face over the backing.
    for (const path of ["src/floor/shifts/shift-hub.css", "src/floor/kit/floor-controls.css"]) {
      const css = read(path);
      expect(css).not.toMatch(/\.shift-card__photo\s*\{[^}]*background:/);
      expect(css).not.toMatch(/\.floor-photo-square\s*\{[^}]*background:/);
    }
    expect(rule(WORK, ".work-shift-band__photo")).not.toMatch(/background/);
  });

  it("makes the band's photo a square as tall as the whole band", () => {
    const photo = rule(WORK, ".work-shift-band__photo");
    expect(photo).toMatch(/align-self:\s*stretch/);
    expect(photo).toMatch(/aspect-ratio:\s*1/);
    // No padding on the photo's side, so nothing is left above, below or beside it.
    expect(rule(WORK, ".work-shift-band")).toMatch(/padding:\s*0 var\(--sp-4\) 0 0/);
    // The picture is laid over the frame, so its natural size never sizes the band.
    expect(rule(WORK, ".work-shift-band__photo .product-photo")).toMatch(/position:\s*absolute/);
  });
});
