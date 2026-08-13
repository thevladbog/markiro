import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoxFillInstrument, buildBoxCells } from "../src/ui/work/BoxFillInstrument.js";
import { RecentOperations } from "../src/ui/work/RecentOperations.js";
import { ScanResultInstrument } from "../src/ui/work/ScanResultInstrument.js";
import { WorkCounters } from "../src/ui/work/WorkCounters.js";
import { WorkFooter } from "../src/ui/work/WorkFooter.js";

const labels = {
  waiting: "Waiting for a scan",
  ok: "Accepted",
  duplicate: "Duplicate",
  invalid: "Invalid code",
  wrong_gtin: "Wrong product",
  unknown: "Rejected",
  gtin: "GTIN",
  serial: "Serial number",
  crypto: "Crypto tail",
};

const boxLabels = {
  title: "Open box",
  number: "Box no. 1",
  absent: "No open box",
  count: "Items",
  capacityUnknown: "Capacity not set",
  grouped: "Cells group several positions",
  close: "Close box",
  undo: "Undo last scan",
  clear: "Clear box",
};

describe("work instruments", () => {
  it("keeps a long product identity and a non-color-only latest result visible", () => {
    const longName = "A very long production product name ".repeat(8);
    const { rerender } = render(
      <ScanResultInstrument
        productName={longName}
        counterpartyName="Plant North"
        operation={null}
        labels={labels}
      />,
    );
    expect(screen.getByRole("heading", { name: longName.trim() })).toBeDefined();
    expect(screen.getByText("Waiting for a scan")).toBeDefined();

    rerender(
      <ScanResultInstrument
        productName={longName}
        counterpartyName="Plant North"
        operation={{
          verdict: "ok",
          scannedAt: "2026-08-06T10:00:00.000Z",
          codeSuffix: "…5Ab1",
          identity: {
            gtin14: "04600000000015",
            serial: "SERIAL-42",
            crypto: [
              { ai: "91", value: "KEY" },
              { ai: "92", value: "SIGNATURE" },
              { ai: "93", value: "TAIL" },
            ],
            normalized: "(01)04600000000015 (21)SERIAL-42 (91)KEY (92)SIGNATURE (93)TAIL",
          },
        }}
        labels={labels}
      />,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Accepted");
    expect(status.textContent).toContain("GTIN");
    expect(status.textContent).toContain("04600000000015");
    expect(status.textContent).toContain("Serial number");
    expect(status.textContent).toContain("SERIAL-42");
    expect(status.textContent).toContain("Crypto tail");
    expect(status.textContent).toContain("(91) KEY · (92) SIGNATURE · (93) TAIL");
    expect(status.textContent).not.toContain("\u001d");
  });

  it("handles absent, unknown, zero, and over-capacity boxes without invalid progress", () => {
    const callbacks = {
      onClose: vi.fn(),
      onUndo: vi.fn(),
      onClear: vi.fn(),
    };
    const { rerender } = render(
      <BoxFillInstrument
        box={null}
        ordinal={null}
        acceptedToken={null}
        capacity={null}
        canUndo={false}
        labels={boxLabels}
        {...callbacks}
      />,
    );
    expect(screen.getByText("No open box")).toBeDefined();
    expect(screen.queryByRole("progressbar")).toBeNull();

    rerender(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 12 }}
        ordinal={1}
        acceptedToken={null}
        capacity={0}
        canUndo={false}
        labels={boxLabels}
        {...callbacks}
      />,
    );
    expect(screen.getByText("Capacity not set")).toBeDefined();
    expect(screen.queryByRole("progressbar")).toBeNull();

    rerender(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 12 }}
        ordinal={1}
        acceptedToken={null}
        capacity={10}
        canUndo
        labels={boxLabels}
        {...callbacks}
      />,
    );
    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("10");
    expect(screen.getByTestId("box-progress").textContent).toBe("12 / 10");
    const undo = screen.getByRole("button", { name: "Undo last scan" });
    expect(undo.classList.contains("mk-btn--floor")).toBe(true);
    fireEvent.click(undo);
    expect(callbacks.onUndo).toHaveBeenCalledOnce();
  });

  it("builds exact cells and marks the next physical position", () => {
    expect(buildBoxCells(2, 20)).toHaveLength(20);
    expect(buildBoxCells(2, 20).filter((cell) => cell.state === "filled")).toHaveLength(2);
    expect(buildBoxCells(2, 20)[2]).toMatchObject({ state: "next", from: 3, to: 3 });
    expect(buildBoxCells(100, 100)).toHaveLength(100);
  });

  it("groups capacities over one hundred without hiding the exact range", () => {
    const grouped = buildBoxCells(37, 101);
    expect(grouped.length).toBeLessThanOrEqual(100);
    expect(grouped[0]).toEqual(expect.objectContaining({ from: 1, to: 2 }));
    expect(grouped.at(-1)?.to).toBe(101);
  });

  it("renders one cell per position and exposes the exact box progress", () => {
    const { container } = render(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 2 }}
        ordinal={1}
        acceptedToken="scan-2"
        capacity={20}
        canUndo={false}
        labels={boxLabels}
        onClose={vi.fn()}
        onUndo={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const progress = screen.getByRole("progressbar", { name: "Open box" });
    expect(progress.getAttribute("aria-valuenow")).toBe("2");
    expect(progress.getAttribute("aria-valuetext")).toBe("2 / 20");
    expect(container.querySelectorAll(".work-box-fill__cell")).toHaveLength(20);
    expect(container.querySelector('.work-box-fill__cell[data-state="next"]')).not.toBeNull();
    expect(container.querySelector('.work-box-fill__cell[data-latest="true"]')).not.toBeNull();
    expect(container.querySelector(".work-box-fill__track")).toBeNull();
  });

  it.each([
    { capacity: 20, rows: 2, grouped: "false" },
    { capacity: 100, rows: 10, grouped: "false" },
    { capacity: 101, rows: 6, grouped: "true" },
  ])("bounds a $capacity-place grid to $rows explicit rows", ({ capacity, rows, grouped }) => {
    const { container } = render(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 0 }}
        ordinal={1}
        acceptedToken={null}
        capacity={capacity}
        canUndo={false}
        labels={boxLabels}
        onClose={vi.fn()}
        onUndo={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const section = container.querySelector(".work-box-fill");
    const grid = container.querySelector<HTMLElement>(".work-box-fill__grid");
    expect(section?.getAttribute("data-grouped")).toBe(grouped);
    expect(grid?.style.gridTemplateRows).toBe(`repeat(${rows}, minmax(0, 1fr))`);
  });

  it("restarts the grouped-cell animation for consecutive accepts but not on remount", () => {
    const props = {
      ordinal: 1,
      capacity: 101,
      canUndo: false,
      labels: boxLabels,
      onClose: vi.fn(),
      onUndo: vi.fn(),
      onClear: vi.fn(),
    };
    const { container, rerender } = render(
      <BoxFillInstrument {...props} box={{ boxId: "b1", itemCount: 1 }} acceptedToken={null} />,
    );
    expect(container.querySelector('[data-latest="true"]')).toBeNull();

    rerender(
      <BoxFillInstrument {...props} box={{ boxId: "b1", itemCount: 1 }} acceptedToken="scan-1" />,
    );
    const firstAnimationCell = container.querySelector('[data-latest="true"]');
    expect(firstAnimationCell?.getAttribute("aria-label")).toBe("1–2");

    rerender(
      <BoxFillInstrument {...props} box={{ boxId: "b1", itemCount: 2 }} acceptedToken="scan-2" />,
    );
    const secondAnimationCell = container.querySelector('[data-latest="true"]');
    expect(secondAnimationCell?.getAttribute("aria-label")).toBe("1–2");
    expect(secondAnimationCell).not.toBe(firstAnimationCell);
  });

  it("shows large counters and explicit synchronized or pending state", () => {
    const { rerender } = render(
      <WorkCounters
        accepted={1234567}
        rejected={98765}
        pendingSync={17}
        labels={{ accepted: "Accepted", rejected: "Rejected", synchronized: "Synchronized" }}
      />,
    );
    expect(screen.getByText("1,234,567")).toBeDefined();
    expect(screen.getByText("98,765")).toBeDefined();
    expect(screen.getByText("17 pending")).toBeDefined();

    rerender(
      <WorkCounters
        accepted={0}
        rejected={0}
        pendingSync={0}
        labels={{ accepted: "Accepted", rejected: "Rejected", synchronized: "Synchronized" }}
      />,
    );
    expect(screen.getByText("Synchronized")).toBeDefined();
  });

  it("renders no more than six recent rows and labels malformed time safely", () => {
    render(
      <RecentOperations
        operations={Array.from({ length: 8 }, (_, index) => ({
          verdict: index === 0 ? "duplicate" : "ok",
          scannedAt: index === 0 ? null : `2026-08-06T10:0${index}:00.000Z`,
          codeSuffix: `…000${index}`,
          identity: {
            gtin14: "04600000000015",
            serial: `SERIAL-${index}`,
            crypto: [],
            normalized: `(01)04600000000015 (21)SERIAL-${index}`,
          },
        }))}
        labels={{ title: "Recent operations", empty: "No scans yet", invalidTime: "Time unknown" }}
        statusLabels={labels}
        locale="en-US"
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("Duplicate")).toBeDefined();
    expect(screen.getByText("Time unknown")).toBeDefined();
    expect(screen.getAllByText("04600000000015")).toHaveLength(6);
    expect(screen.getByText("SERIAL-0")).toBeDefined();
    expect(screen.queryByText("SERIAL-7")).toBeNull();
  });

  it("exposes fixed floor footer actions through plain callbacks", () => {
    const onExceptions = vi.fn();
    const onExit = vi.fn();
    render(
      <WorkFooter
        onExceptions={onExceptions}
        onExit={onExit}
        labels={{ exceptions: "Exceptions", exit: "Pause / finish" }}
      />,
    );
    const exceptionButton = screen.getByRole("button", { name: "Exceptions" });
    const exitButton = screen.getByRole("button", { name: "Pause / finish" });
    expect(exceptionButton.classList.contains("mk-btn--floor")).toBe(true);
    fireEvent.click(exceptionButton);
    fireEvent.click(exitButton);
    expect(onExceptions).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
  });
});
