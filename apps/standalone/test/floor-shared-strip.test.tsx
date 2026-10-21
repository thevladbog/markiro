import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import { formatClock, formatQuantity } from "../src/floor/shifts/shift-text.js";
import { ShiftBand } from "../src/floor/work/WorkInstruments.js";
import { enteredShift, km } from "./support/floor-work.js";
import { openLocalDb } from "./support/local-db.js";
import {
  enteredOf,
  HANDHELD,
  participant,
  SHARED_ENTERED,
  sharedShift,
  STATION_ROW,
} from "./support/multi-station.js";
import { renderWork } from "./support/work-screen.js";

// `formatQuantity` groups with a no-break space; the DOM queries normalize it to a plain one.
const plain = (text: string) => text.replace(/\s+/g, " ");
const count = () => document.querySelector(".work-shift-band__count")?.textContent ?? null;
const mine = () =>
  document.querySelector(".work-shift-band__small--mine .work-shift-band__small-count")
    ?.textContent ?? null;

function band(
  shared: { mine: number; total: number; asOf: string; stale: boolean },
  plannedQty: number | null,
) {
  render(
    <ThemeProvider>
      <ShiftBand
        productName="Молоко 3,2% 0,9 л"
        gtin="04600682000013"
        number="OCT26-004"
        counterpartyName={null}
        accepted={shared.mine}
        plannedQty={plannedQty}
        modeLabel="Агрегация"
        shared={shared}
      />
    </ThemeProvider>,
  );
}

describe("the strip of a shared shift (plan 2b, spec §5 «Рабочий экран»)", () => {
  it("says this station's count and the whole shift's against the plan, and names them in the owner's words", () => {
    band({ mine: 427, total: 547, asOf: "2026-10-08T09:41:07Z", stale: false }, 1200);
    expect(screen.getByText("Всего в смене")).toBeTruthy();
    expect(screen.getByText("Моя станция")).toBeTruthy();
    expect([count(), mine()]).toEqual(["547", "427"]);
    expect(screen.getByText(plain(`/ ${formatQuantity(1200)}`))).toBeTruthy();
    expect(
      screen.getByRole("group", {
        name: `Моя станция: 427 · Всего в смене: 547 из ${formatQuantity(1200)}`,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/данные от/)).toBeNull();
  });

  it("says how old the host's part is when the link is down", () => {
    band({ mine: 3, total: 5, asOf: "2026-10-08T09:41:07Z", stale: true }, 1200);
    expect(screen.getByText(`данные от ${formatClock("2026-10-08T09:41:07Z")}`)).toBeTruthy();
  });

  it("names the counts of a shift without a plan", () => {
    band({ mine: 3, total: 5, asOf: "2026-10-08T09:41:07Z", stale: false }, null);
    expect(screen.getByRole("group", { name: "Моя станция: 3 · Всего в смене: 5" })).toBeTruthy();
  });
});

describe("the work screen of a shared shift (plan 2b)", () => {
  it("counts the whole shift with this station's own scans at once, and closes «мою часть»", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, SHARED_ENTERED);
    const work = renderWork(
      { local: executor, shift },
      { overrides: { online: true, shiftReads: 1 } },
    );
    // The others' part by the host (547 − 427 = 120); this station holds no code of it here.
    await waitFor(() => expect(count()).toBe("120"));
    expect(mine()).toBe("0");
    await work.scanner.listening();
    await work.scan(km("A1"));
    await waitFor(() => expect(count()).toBe("121"));
    expect(mine()).toBe("1");
    expect(screen.getByRole("button", { name: "Закрыть мою часть" })).toBeTruthy();
    expect(screen.queryByText(/данные от/)).toBeNull();
  });

  it("marks the host's figures with their time when the link is down", async () => {
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, SHARED_ENTERED);
    renderWork({ local: executor, shift }, { overrides: { online: false } });
    expect(
      await screen.findByText(`данные от ${formatClock("2026-10-08T09:41:07Z")}`),
    ).toBeTruthy();
  });

  it("reaches the plan by the whole shift, once, until it is dismissed", async () => {
    const near = enteredOf(
      sharedShift({
        participants: [
          { row: STATION_ROW, accepted: 0 },
          { row: participant(HANDHELD, "ТСД 1", "active", "handheld"), accepted: 1199 },
        ],
        myState: "active",
      }),
    );
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, near);
    const work = renderWork({ local: executor, shift }, { overrides: { online: true } });
    await waitFor(() => expect(count()).toBe(formatQuantity(1199)));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
    await work.scanner.listening();
    await work.scan(km("A1"));
    expect(
      await screen.findByText(
        plain(`План выполнен: принято ${formatQuantity(1200)} из ${formatQuantity(1200)}.`),
      ),
    ).toBeTruthy();
    await work.press("Продолжить");
    expect(screen.queryByText(/План выполнен/)).toBeNull();
    await work.scan(km("A2"));
    await waitFor(() => expect(count()).toBe(formatQuantity(1201)));
    expect(screen.queryByText(/План выполнен/)).toBeNull();
  });

  it("a close opened and left before the plan was reached does not take away the notice that comes later (final review m5)", async () => {
    const below = enteredOf(
      sharedShift({
        participants: [
          { row: STATION_ROW, accepted: 0 },
          { row: participant(HANDHELD, "ТСД 1", "active", "handheld"), accepted: 1198 },
        ],
        myState: "active",
      }),
    );
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, below);
    const work = renderWork({ local: executor, shift }, { overrides: { online: true } });
    await waitFor(() => expect(count()).toBe(formatQuantity(1198)));
    await work.scanner.listening();
    await work.scan(km("B1"));
    await waitFor(() => expect(count()).toBe(formatQuantity(1199)));
    // No notice shows while the close is opened and left: there is none to dismiss.
    await work.press("Закрыть мою часть");
    await screen.findByRole("region", { name: /Закрытие моей части смены/ });
    await work.press("Назад к работе");
    await work.scan(km("B2"));
    expect(
      await screen.findByText(
        plain(`План выполнен: принято ${formatQuantity(1200)} из ${formatQuantity(1200)}.`),
      ),
    ).toBeTruthy();
  });

  it("keeps a solo station's screen as it was on a line of one", async () => {
    const solo = enteredOf(
      sharedShift({
        participants: [{ row: STATION_ROW, accepted: 5 }],
        maxStations: 1,
        myState: "active",
      }),
    );
    const { executor } = openLocalDb();
    const shift = await enteredShift(executor, solo);
    renderWork({ local: executor, shift }, { overrides: { online: true } });
    expect(await screen.findByText("Принято в смене")).toBeTruthy();
    expect(screen.queryByText("Всего в смене")).toBeNull();
    expect(screen.getByRole("button", { name: "Закрыть смену" })).toBeTruthy();
  });
});
