import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import {
  COMPACT_ROWS,
  ScanHistory,
  ScanHistoryScreen,
  PAGE_ROWS,
  useScanHistory,
} from "../src/floor/work/ScanHistory.js";
import type { LocalExecutor } from "../src/local/executor.js";
import { maskCode, readScanHistory } from "../src/floor/work/scan-history.js";
import { DEVICE_ID, HOST_ID } from "./support/fixtures.js";
import { openLocalDb } from "./support/local-db.js";

/** The work screen's one read of the newest scans, and the list that shows it. */
function Compact({
  local,
  refreshKey,
  onOpenAll,
}: {
  local: LocalExecutor;
  refreshKey: unknown;
  onOpenAll: () => void;
}) {
  const read = useScanHistory(local, PAIRING, SHIFT, COMPACT_ROWS, 0, refreshKey, true);
  return <ScanHistory read={read} onOpenAll={onOpenAll} />;
}

const PAIRING = { hostId: HOST_ID, deviceId: DEVICE_ID };
const SHIFT = "bbbbbbbb-0000-4000-8000-000000000001";
const OTHER_SHIFT = "bbbbbbbb-0000-4000-8000-000000000002";
const BOX = "cccccccc-0000-4000-8000-000000000001";
const OPERATOR = "dddddddd-0000-4000-8000-000000000001";

interface Seed {
  id: string;
  at: string;
  verdict: "ok" | "duplicate" | "wrong_gtin" | "invalid";
  source?: "local" | "host";
  box?: string | null;
  kind?: "km" | "gtin" | "sscc" | "unknown";
  serial?: string;
  shift?: string;
}

function history(seeds: Seed[]) {
  const { db, executor } = openLocalDb();
  db.prepare(
    "INSERT INTO ref_operators (id, login, name, role, pin_phc, rev) VALUES (?, '0042', 'Анна Кузнецова', NULL, 'x', 1)",
  ).run(OPERATOR);
  for (const seed of seeds) {
    const km = (seed.kind ?? "km") === "km";
    db.prepare(
      "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, scanned_at, operator_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 40, ?, ?, ?, ?, ?, ?)",
    ).run(
      seed.id,
      HOST_ID,
      DEVICE_ID,
      seed.shift ?? SHIFT,
      seed.verdict === "ok" ? (seed.box ?? BOX) : null,
      seed.verdict,
      seed.verdict === "duplicate" ? (seed.source ?? "local") : null,
      seed.kind ?? "km",
      km ? `hash-${seed.id}` : null,
      km ? "04600682000013" : null,
      km ? (seed.serial ?? "ABCDEF1234") : null,
      km ? "canonical" : null,
      seed.at,
      OPERATOR,
    );
  }
  return executor;
}

const SEEDS: Seed[] = [
  { id: "s1", at: "2026-10-15T06:00:01.000Z", verdict: "ok", serial: "AAAA0001" },
  { id: "s2", at: "2026-10-15T06:00:02.000Z", verdict: "ok", serial: "AAAA0002" },
  {
    id: "s3",
    at: "2026-10-15T06:00:03.000Z",
    verdict: "duplicate",
    source: "host",
    serial: "AAAA0002",
  },
  { id: "s4", at: "2026-10-15T06:00:04.000Z", verdict: "wrong_gtin", serial: "ZZZZ9999" },
  { id: "s5", at: "2026-10-15T06:00:05.000Z", verdict: "invalid", kind: "unknown" },
  { id: "x1", at: "2026-10-15T06:00:06.000Z", verdict: "ok", shift: OTHER_SHIFT },
];

describe("the shift's scan history, from this station's own scans", () => {
  it("masks a code to its GTIN and the tail of its serial", () => {
    expect(maskCode("04600682000013", "ABCDEF1234")).toBe("04600682000013 …1234");
    expect(maskCode("04600682000013", "AB")).toBe("04600682000013 …AB");
    expect(maskCode(null, null)).toBeNull();
  });

  it("reads this shift's scans newest first, with the operator, the place in the box and the mask", async () => {
    const local = history(SEEDS);
    const { rows, total } = await readScanHistory(local, PAIRING, SHIFT, { limit: 10, offset: 0 });
    expect(total).toBe(5);
    expect(rows.map((row) => [row.id, row.verdict, row.boxPosition, row.maskedCode])).toEqual([
      ["s5", "invalid", null, null],
      ["s4", "wrong_gtin", null, "04600682000013 …9999"],
      ["s3", "duplicate", null, "04600682000013 …0002"],
      ["s2", "ok", 2, "04600682000013 …0002"],
      ["s1", "ok", 1, "04600682000013 …0001"],
    ]);
    expect(rows.every((row) => row.operatorName === "Анна Кузнецова")).toBe(true);
    expect(rows.find((row) => row.id === "s3")?.duplicateSource).toBe("host");
    // A page is a slice of the same order.
    const page = await readScanHistory(local, PAIRING, SHIFT, { limit: 2, offset: 3 });
    expect(page.rows.map((row) => row.id)).toEqual(["s2", "s1"]);
    // Another pairing sees nothing of it.
    const other = await readScanHistory(
      local,
      { hostId: HOST_ID, deviceId: "00000000-0000-4000-8000-000000000000" },
      SHIFT,
      { limit: 10, offset: 0 },
    );
    expect(other.total).toBe(0);
  });

  it("lists the last scans with their result chips, reasons and no whole code", async () => {
    const local = history(SEEDS);
    render(
      <ThemeProvider>
        <Compact local={local} refreshKey={0} onOpenAll={() => undefined} />
      </ThemeProvider>,
    );
    const list = await screen.findByRole("list", { name: "История сканирований" });
    const items = within(list).getAllByRole("listitem");
    // The shift's five scans, newest first (the other shift's is not here).
    expect(items).toHaveLength(5);
    expect(items[0]?.textContent).toContain("Не код");
    expect(items[1]?.textContent).toContain("Другой товар");
    expect(items[2]?.textContent).toContain("Дубль");
    // A row is its time, its result chip and its code: the reason, operator and place are
    // said to a screen reader, and the full history shows them as columns.
    expect(items[2]?.getAttribute("aria-label")).toContain("уже принят на другой станции");
    expect(items[4]?.textContent).toContain("Принят");
    expect(items[4]?.getAttribute("aria-label")).toContain("№ 1");
    expect(items[3]?.getAttribute("aria-label")).toContain("Анна Кузнецова");
    expect(items[3]?.textContent).toContain("…0002");
    expect(list.textContent).not.toContain("AAAA0002");
  });

  it("is one list of at most eight rows with its «Вся история» button", async () => {
    const seeds: Seed[] = Array.from({ length: 11 }, (_, index) => ({
      id: `m${index}`,
      at: `2026-10-15T06:01:${String(index).padStart(2, "0")}.000Z`,
      verdict: "ok",
      serial: `BBBB${String(index).padStart(4, "0")}`,
    }));
    const local = history(seeds);
    render(
      <ThemeProvider>
        <Compact local={local} refreshKey={0} onOpenAll={() => undefined} />
      </ThemeProvider>,
    );
    const list = await screen.findByRole("list", { name: "История сканирований" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(8);
    expect(document.querySelectorAll(".scan-history--compact")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Вся история" })).toHaveLength(1);
    expect(
      screen.getByText("Показаны последние записи. Полный список — «Вся история»."),
    ).toBeTruthy();
    // The newest first, and the list is a keyboard-reachable scroll region.
    expect(within(list).getAllByRole("listitem")[0]?.textContent).toContain("…0010");
    expect(list.getAttribute("tabindex")).toBe("0");
  });

  it("reads again when the work screen says a scan was made", async () => {
    const local = history(SEEDS.slice(0, 2));
    const view = render(
      <ThemeProvider>
        <Compact local={local} refreshKey={0} onOpenAll={() => undefined} />
      </ThemeProvider>,
    );
    await screen.findAllByRole("listitem");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await local.transaction([
      {
        sql: "INSERT INTO floor_scans (id, host_id, device_id, shift_id, box_id, verdict, duplicate_source, raw_kind, raw_length, code_hash, gtin14, serial, canonical, scanned_at, operator_id) VALUES ('s9', ?, ?, ?, ?, 'ok', NULL, 'km', 40, 'h9', '04600682000013', 'NEW00009', 'c', '2026-10-15T06:10:00.000Z', NULL)",
        values: [HOST_ID, DEVICE_ID, SHIFT, BOX],
      },
    ]);
    view.rerender(
      <ThemeProvider>
        <Compact local={local} refreshKey={1} onOpenAll={() => undefined} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
  });

  it("says so when the shift has no scans yet, and opens the full history by its button", async () => {
    const local = history([]);
    let opened = 0;
    render(
      <ThemeProvider>
        <Compact
          local={local}
          refreshKey={0}
          onOpenAll={() => {
            opened += 1;
          }}
        />
      </ThemeProvider>,
    );
    expect(await screen.findByText("В этой смене сканов ещё не было.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Вся история" }));
    expect(opened).toBe(1);
  });

  it("pages the full history with 64 px rows' worth to a page and a way back", async () => {
    const many: Seed[] = Array.from({ length: PAGE_ROWS + 3 }, (_, index) => ({
      id: `m${index}`,
      at: `2026-10-15T07:${String(index).padStart(2, "0")}:00.000Z`,
      verdict: "ok",
      serial: `SER${String(index).padStart(5, "0")}`,
    }));
    const local = history(many);
    let back = 0;
    render(
      <ThemeProvider>
        <ScanHistoryScreen
          local={local}
          pairing={PAIRING}
          shiftId={SHIFT}
          refreshKey={0}
          onBack={() => {
            back += 1;
          }}
        />
      </ThemeProvider>,
    );
    await screen.findAllByRole("listitem");
    expect(screen.getAllByRole("listitem")).toHaveLength(PAGE_ROWS);
    expect(screen.getByText("Страница 1 из 2")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Предыдущая страница" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Следующая страница" }));
    await waitFor(() => expect(screen.getByText("Страница 2 из 2")).toBeTruthy());
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("mk-btn--floor");
    }
    fireEvent.click(screen.getByRole("button", { name: "К смене" }));
    expect(back).toBe(1);
    void act;
  });
});
