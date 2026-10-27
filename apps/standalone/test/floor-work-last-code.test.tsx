import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeProvider, type SignalTone } from "@markiro/ui";

import type { FloorSession } from "../src/app/shell.js";
import type { ScanListener, ScanSource } from "../src/floor/scan-source.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import { createWorkGate } from "../src/floor/work-gate.js";
import { readScanHistory, SCAN_HISTORY_SQL } from "../src/floor/work/scan-history.js";
import { WorkScreen, type WorkScreenProps } from "../src/floor/work/WorkScreen.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import type { CodeCheck, SsccBlockRequest } from "../src/host/protocol.js";
import { LocalDbError, type LocalExecutor } from "../src/local/executor.js";
import { enteredShift, GTIN, km, OPERATOR_ID, OTHER_GTIN, PAIRING } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { fakeRender, setUpPrinting } from "./support/printing.js";

const SESSION: FloorSession = {
  id: OPERATOR_ID,
  login: "0042",
  name: "Анна Кузнецова",
  role: null,
  sessionId: 1,
};

/**
 * The station's database with the history read (`SCAN_HISTORY_SQL`) held until the test lets
 * it go, or failing: counts how many such reads started and how many ran at once.
 */
function historyHeld(local: LocalExecutor, mode: "hold" | "fail") {
  let started = 0;
  let running = 0;
  let mostAtOnce = 0;
  const waiting: (() => void)[] = [];
  const executor: LocalExecutor = {
    query: async (sql, params, row) => {
      if (sql !== SCAN_HISTORY_SQL) return local.query(sql, params, row);
      started += 1;
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      try {
        if (mode === "fail") throw new LocalDbError("statement_failed", "the disk is gone");
        await new Promise<void>((resolve) => waiting.push(resolve));
        return await local.query(sql, params, row);
      } finally {
        running -= 1;
      }
    },
    transaction: (statements) => local.transaction(statements),
  };
  return {
    executor,
    counts: () => ({ started, running, mostAtOnce }),
    /** Lets every held read go on. */
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

async function workScreen(local: LocalExecutor) {
  const gate = createWorkGate();
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
  const props: WorkScreenProps = {
    shift: await enteredShift(local),
    operator: SESSION,
    pairing: PAIRING,
    local,
    online: false,
    track: gate.track,
    touch: vi.fn(),
    onLeave: vi.fn(),
    leaving: false,
    source,
    checkCode: vi.fn(async (): Promise<CodeCheck> => ({ status: "free" })),
    requestBlock: vi.fn(async (request: SsccBlockRequest) => ({
      id: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a",
      issuerPrefix: request.issuerPrefix,
      extension: request.extension,
      fromSerial: 3500,
      toSerial: 5499,
    })),
    onHostError: vi.fn(),
    onRecorded: vi.fn(),
    signal: vi.fn<(tone: SignalTone) => void>(),
    printing: createPrintRuntime(fakeHardware().hardware.printBytes),
    awake: createSystemAwake(vi.fn(async () => undefined)),
    render: fakeRender,
  };
  render(
    <ThemeProvider>
      <WorkScreen {...props} />
    </ThemeProvider>,
  );
  await waitFor(() => {
    if (listener === null) throw new Error("the work screen does not listen yet");
  });
  return {
    /** Scans `raw` and waits for the scan's own work (not for the history list). */
    scan: (raw: string) =>
      act(async () => {
        listener?.(raw);
        await gate.drain();
      }),
    /** Hands a scan over as the scanner does, and returns at once. */
    emit: (raw: string) => listener?.(raw),
    drain: () =>
      act(async () => {
        await gate.drain();
      }),
  };
}

function heroCode(): string | null {
  return document.querySelector(".work-screen__last .work-scan-hero__code")?.textContent ?? null;
}

async function station() {
  const { executor } = openLocalDb();
  await setUpPrinting(executor);
  return executor;
}

describe("the last scan's code comes with its verdict (scan lag fix)", () => {
  it("shows the code of an accepted scan while the history read still waits", async () => {
    const held = historyHeld(await station(), "hold");
    const screenOf = await workScreen(held.executor);
    await screenOf.scan(km("LAG0000001"));
    // The verdict and the code are on the hero; the list has not been read yet.
    expect(document.querySelector(".work-screen__last")?.getAttribute("data-verdict")).toBe("ok");
    expect(heroCode()).toContain("LAG0000001");
    expect(heroCode()).toContain(`…${GTIN.slice(-6)}`);
    held.release();
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "История сканирований" })).getAllByRole("listitem"),
      ).toHaveLength(1),
    );
    expect(heroCode()).toContain("LAG0000001");
  });

  it("shows the code of a refused scan when the history read fails, and no code for a scan that was none", async () => {
    const held = historyHeld(await station(), "fail");
    const screenOf = await workScreen(held.executor);
    await screenOf.scan(km("LAG0000002", { gtin: OTHER_GTIN }));
    expect(document.querySelector(".work-screen__last")?.getAttribute("data-verdict")).toBe(
      "error",
    );
    expect(heroCode()).toContain("LAG0000002");
    expect(heroCode()).toContain(`…${OTHER_GTIN.slice(-6)}`);
    await waitFor(() =>
      expect(screen.getByText("История не прочиталась. Работа смены не затронута.")).toBeTruthy(),
    );
    // A scan that is no code of marking keeps no text, so the hero shows no code for it.
    await screenOf.scan("MRK-000742");
    expect(heroCode()).toBeNull();
  });

  it("keeps one history read in flight under 50 rapid scans, and ends on the newest rows", async () => {
    const held = historyHeld(await station(), "hold");
    const screenOf = await workScreen(held.executor);
    // The screen's first read is in flight and held.
    await waitFor(() => expect(held.counts().started).toBe(1));
    await act(async () => {
      for (let index = 0; index < 50; index += 1) {
        screenOf.emit(km(`RAPID${String(index).padStart(5, "0")}`, { gtin: OTHER_GTIN }));
      }
    });
    await screenOf.drain();
    expect(heroCode()).toContain("RAPID00049");
    // Fifty scans later, still the one read; the others are folded into the next one.
    expect(held.counts()).toMatchObject({ started: 1, mostAtOnce: 1 });
    held.release();
    await waitFor(() => expect(held.counts().started).toBe(2));
    held.release();
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "История сканирований" })).getAllByRole(
          "listitem",
        )[0]?.textContent,
      ).toContain("RAPID00049"),
    );
    expect(held.counts()).toEqual({ started: 2, running: 0, mostAtOnce: 1 });
  });
});

describe("the history reads of the station take one reader at a time", () => {
  it("starts a second history read only when the first one ended", async () => {
    const held = historyHeld(await station(), "hold");
    const first = readScanHistory(held.executor, PAIRING, "shift-1", { limit: 8, offset: 0 });
    const second = readScanHistory(held.executor, PAIRING, "shift-1", { limit: 30, offset: 0 });
    await waitFor(() => expect(held.counts().started).toBe(1));
    // The second read waits for the first: one of the two reader connections stays free for
    // the scan path's own reads.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held.counts()).toMatchObject({ started: 1, running: 1 });
    held.release();
    await waitFor(() => expect(held.counts().started).toBe(2));
    held.release();
    await expect(first).resolves.toEqual({ rows: [], total: 0 });
    await expect(second).resolves.toEqual({ rows: [], total: 0 });
    expect(held.counts().mostAtOnce).toBe(1);
  });

  it("lets a failed history read free the way for the next", async () => {
    const failing = historyHeld(await station(), "fail");
    await expect(
      readScanHistory(failing.executor, PAIRING, "shift-1", { limit: 8, offset: 0 }),
    ).rejects.toThrow("the disk is gone");
    await expect(
      readScanHistory(failing.executor, PAIRING, "shift-1", { limit: 8, offset: 0 }),
    ).rejects.toThrow("the disk is gone");
    expect(failing.counts().started).toBe(2);
  });
});
