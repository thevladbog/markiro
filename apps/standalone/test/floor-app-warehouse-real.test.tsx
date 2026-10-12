import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@markiro/ui";

import type { FloorNotice, ShellAction, SyncState } from "../src/app/shell.js";
import { FloorApp } from "../src/floor/FloorApp.js";
import type { renderLabel } from "../src/floor/print/label-render.js";
import { createPrintRuntime } from "../src/floor/print/print-runtime.js";
import { createSystemAwake } from "../src/hardware/awake.js";
import type { HostStatus, WarehouseLookup, WarehouseLookupResult } from "../src/host/protocol.js";
import { DEVICE_STATUS } from "./support/fixtures.js";
import { OPERATOR_ID, rows } from "./support/floor-work.js";
import { fakeHardware } from "./support/hardware.js";
import { openLocalDb } from "./support/local-db.js";
import { setUpPrinting } from "./support/printing.js";
import { BOX_SOURCE, BOX_SSCC, seedWarehouseCopies } from "./support/warehouse.js";
import { fakeSource, SESSION } from "./support/work-screen.js";

// A canvas is not there in jsdom: the bytes of a label are the support's plain text.
vi.mock("../src/floor/print/label-render.js", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const render: typeof renderLabel = async (
    spec,
    fields,
    printer,
    _rasterize,
    _logo,
    options = {},
  ) =>
    new TextEncoder().encode(
      `^XA ${printer.language} ${printer.dpi} ${spec.widthMm}x${spec.heightMm} ` +
        `${fields.sscc === "" ? "km" : fields.sscc} ${options.kmDataMatrix ?? "native"} ^XZ`,
    );
  return { ...original, renderLabel: render };
});

const ONLINE: HostStatus = { state: "online", lastContactAt: 1, lastError: null, seq: 1 };
const SYNCED: SyncState = { kind: "done", synced: 0, failure: null, quarantined: 0 };
const REPRINT = "Повторная печать этикеток";
const UNKNOWN_ANSWER = async () => ({ sent: false as const, code: "outcome_unknown" as const });

afterEach(() => {
  cleanup();
});

/** The screens hold a press that lands just after their view changed (400 ms). */
const pause = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 450));
  });

describe("a label of the warehouse reprint whose outcome is unknown, and the operator leaves the screen", () => {
  it("is still there when the operator comes back, sent no second time, and its record is kept", async () => {
    expect(SESSION.id).toBe(OPERATOR_ID);
    const { db, executor } = openLocalDb();
    seedWarehouseCopies(db);
    await setUpPrinting(executor, {
      assignments: { box: "zebra", pallet: "zebra", duplicate: "tsc" },
    });
    const shell = fakeHardware(UNKNOWN_ANSWER);
    const scanner = fakeSource();
    const lookup = vi.fn(async (_lookup: WarehouseLookup): Promise<WarehouseLookupResult> => ({
      status: "found",
      source: BOX_SOURCE,
    }));
    const dispatch = vi.fn<(action: ShellAction) => void>();
    render(
      <ThemeProvider>
        <FloorApp
          operator={SESSION}
          local={executor}
          device={DEVICE_STATUS}
          link={ONLINE}
          sync={SYNCED}
          shiftReads={{ done: 1, failed: false }}
          lineChangePending={false}
          rejectionPending={false}
          enter={vi.fn()}
          create={vi.fn()}
          checkCode={vi.fn()}
          requestBlock={vi.fn()}
          warehouseLookup={lookup}
          requestFacts={vi.fn()}
          source={scanner.source}
          printing={createPrintRuntime(shell.hardware.printBytes)}
          hardware={shell.hardware}
          awake={createSystemAwake(vi.fn(async () => undefined))}
          dispatch={dispatch}
          onSignOut={vi.fn<(notice: FloorNotice | null) => void>()}
        />
      </ThemeProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: REPRINT }));
    await screen.findByRole("heading", { name: REPRINT });
    await pause();
    fireEvent.click(screen.getByRole("button", { name: "Повреждена" }));
    await pause();
    fireEvent.click(screen.getByRole("button", { name: "Начать перепечатку" }));
    await scanner.listening();
    await pause();
    await act(async () => {
      scanner.emit(BOX_SSCC);
    });
    expect(await screen.findByText(/Неизвестно, вышла ли этикетка/)).toBeTruthy();
    expect(shell.sends).toHaveLength(1);
    // Leave through the floor: the list of shifts, with the session paused.
    await pause();
    fireEvent.click(screen.getByRole("button", { name: "К сменам" }));
    const again = await screen.findByRole("button", { name: REPRINT });
    expect(rows(db, "SELECT state, error_code FROM wh_jobs")).toEqual([
      { state: "unknown", error_code: "outcome_unknown" },
    ]);
    // And in again: the same session, the label's outcome still said, nothing sent by itself.
    fireEvent.click(again);
    expect(await screen.findByText(/Продолжен незавершённый сеанс перепечатки\./)).toBeTruthy();
    expect(screen.getByText("Задание: исход неизвестен")).toBeTruthy();
    expect(screen.getByText(/Неизвестно, вышла ли этикетка/)).toBeTruthy();
    await waitFor(() => expect(shell.sends).toHaveLength(1));
    // The shell heard of the records (the delivery goes after the facts) and of no shift.
    expect(rows(db, "SELECT count(*) AS n FROM wh_outbox")).toEqual([{ n: 1 }]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).not.toContain("work_entered");
  });
});
