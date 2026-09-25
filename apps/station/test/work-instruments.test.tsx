import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { hueFromGtin } from "../src/lib/product-accent.js";
import { BoxFillInstrument, buildBoxCells } from "../src/ui/work/BoxFillInstrument.js";
import { RecentOperations } from "../src/ui/work/RecentOperations.js";
import { ScanResultInstrument } from "../src/ui/work/ScanResultInstrument.js";
import { productMonogram } from "../src/ui/work/ShiftBand.js";
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
  it("prints the latest accepted serial beside the box readout, waiting otherwise", () => {
    const props = {
      box: { boxId: "b1", itemCount: 2 },
      ordinal: 1,
      acceptedToken: null,
      capacity: 10,
      canUndo: false,
      labels: boxLabels,
      verdictLabels: { ok: "Accepted", waiting: "Waiting for a scan" },
      onClose: vi.fn(),
      onUndo: vi.fn(),
      onClear: vi.fn(),
    };
    const { rerender } = render(<BoxFillInstrument {...props} lastAccepted={null} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Waiting for a scan");
    expect(status.getAttribute("data-tone")).toBe("neutral");

    rerender(<BoxFillInstrument {...props} lastAccepted={{ serial: "SERIAL-42" }} />);
    const accepted = screen.getByRole("status");
    expect(accepted.getAttribute("data-tone")).toBe("ok");
    expect(accepted.getAttribute("aria-label")).toBe("Accepted: SERIAL-42");
    expect(accepted.querySelector('[data-semantic="accepted-serial"]')?.textContent).toBe(
      "SERIAL-42",
    );
  });

  it("puts the title, the count and the last serial in one head row", () => {
    const { container } = render(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 2 }}
        ordinal={416}
        acceptedToken={null}
        capacity={20}
        canUndo={false}
        labels={{ ...boxLabels, number: "Box no. 416" }}
        lastAccepted={{ serial: "5A)5>JE" }}
        verdictLabels={{ ok: "Accepted", waiting: "Waiting for a scan" }}
        onClose={vi.fn()}
        onUndo={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    const head = container.querySelector(".work-box-fill__head");
    expect(head?.querySelector("h2")?.textContent).toBe("Box no. 416");
    expect(head?.querySelector('[data-testid="box-progress"]')?.textContent).toBe("2 / 20");
    expect(head?.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Accepted: 5A)5>JE",
    );
    expect(container.querySelector(".work-box-fill__head + .work-box-fill__grid")).not.toBeNull();
  });

  it("derives a stable in-range hue from the GTIN and a first-letter monogram", () => {
    expect(hueFromGtin("04607000000042")).toBe(hueFromGtin("04607000000042"));
    expect(hueFromGtin("04607000000042")).not.toBe(hueFromGtin("04607000000043"));
    for (const gtin of ["04607000000042", "04600000000015", "1"]) {
      const hue = hueFromGtin(gtin);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
    expect(productMonogram("«Балтика 7»")).toBe("Б");
    expect(productMonogram("  ")).toBe("?");
  });

  it("keeps a non-color-only latest result visible", () => {
    const { rerender } = render(<ScanResultInstrument operation={null} labels={labels} />);
    expect(screen.getByText("Waiting for a scan")).toBeDefined();

    rerender(
      <ScanResultInstrument
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
    const status = screen.getByRole("status", {
      name: "Accepted: (01)04600000000015 (21)SERIAL-42",
    });
    const acceptedMarker = status.querySelector('[data-semantic="accepted-marker"]');
    expect(acceptedMarker?.textContent).toBe("✓");
    expect(acceptedMarker?.getAttribute("aria-hidden")).toBe("true");
    expect(status.querySelector('[data-semantic="normalized-code"]')?.textContent).toBe(
      "(01)04600000000015 (21)SERIAL-42",
    );
    expect(status.querySelector('[data-semantic="verdict"]')).toBeNull();
    expect(status.querySelector('[data-semantic="gtin"]')).toBeNull();
    expect(status.querySelector('[data-semantic="serial"]')).toBeNull();
    expect(status.querySelector('[data-semantic="crypto"]')).toBeNull();
    expect(status.textContent).not.toContain("Accepted");
    expect(status.textContent).not.toContain("GTIN");
    expect(status.textContent).not.toContain("Serial number");
    expect(status.textContent).not.toContain("Crypto tail");
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

  it("renders a ten-place box as one row of numbered segments", () => {
    const { container } = render(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 7 }}
        ordinal={1}
        acceptedToken={null}
        capacity={10}
        canUndo={false}
        labels={boxLabels}
        onClose={vi.fn()}
        onUndo={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const grid = container.querySelector<HTMLElement>(".work-box-fill__grid");
    expect(grid?.getAttribute("data-large")).toBe("true");
    expect(grid?.style.gridTemplateColumns).toBe("repeat(10, minmax(0, 1fr))");
    const cells = container.querySelectorAll(".work-box-fill__cell");
    expect(cells).toHaveLength(10);
    expect(cells[0]?.textContent).toBe("1");
    expect(cells[9]?.textContent).toBe("10");
    expect(cells[6]?.getAttribute("data-state")).toBe("filled");
    expect(cells[7]?.getAttribute("data-state")).toBe("next");
  });

  it("keeps the rows-of-ten grid without numbers above ten places", () => {
    const { container } = render(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 2 }}
        ordinal={1}
        acceptedToken={null}
        capacity={20}
        canUndo={false}
        labels={boxLabels}
        onClose={vi.fn()}
        onUndo={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const grid = container.querySelector<HTMLElement>(".work-box-fill__grid");
    expect(grid?.getAttribute("data-large")).toBeNull();
    expect(grid?.style.gridTemplateColumns).toBe("");
    expect(container.querySelector(".work-box-fill__cell")?.textContent).toBe("");
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

  it("renders the shift journal: six rows, serials, and the shift's error counts", () => {
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
        counts={{ errors: 2, duplicates: 3 }}
        labels={{
          title: "Shift journal",
          empty: "No scans yet",
          invalidTime: "Time unknown",
          errors: "Errors",
          duplicates: "Duplicates",
        }}
        statusLabels={labels}
        locale="en-US"
      />,
    );
    expect(screen.getByRole("heading", { name: "Shift journal" })).toBeDefined();
    expect(screen.getByTestId("journal-errors").textContent).toBe("2");
    expect(screen.getByTestId("journal-duplicates").textContent).toBe("3");
    expect(screen.getByTestId("journal-duplicates").getAttribute("data-tone")).toBe("warn");
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText("Duplicate")).toBeDefined();
    expect(screen.getByText("Time unknown")).toBeDefined();
    expect(screen.queryByText(/04600000000015/)).toBeNull();
    expect(screen.getByText("SERIAL-0")).toBeDefined();
    expect(screen.queryByText("SERIAL-7")).toBeNull();
  });

  it("exposes fixed floor footer actions through plain callbacks", () => {
    const onExceptions = vi.fn();
    const onPause = vi.fn();
    const onClose = vi.fn();
    render(
      <WorkFooter
        onExceptions={onExceptions}
        onPause={onPause}
        onClose={onClose}
        labels={{ exceptions: "Exceptions", pause: "Pause", close: "Close shift" }}
      />,
    );
    const exceptionButton = screen.getByRole("button", { name: "Exceptions" });
    const pauseButton = screen.getByRole("button", { name: "Pause" });
    const closeButton = screen.getByRole("button", { name: "Close shift" });
    expect(exceptionButton.classList.contains("mk-btn--floor")).toBe(true);
    expect(exceptionButton.classList.contains("mk-btn--secondary")).toBe(true);
    expect(pauseButton.classList.contains("mk-btn--warning-outline")).toBe(true);
    expect(closeButton.classList.contains("mk-btn--destructive-outline")).toBe(true);
    for (const button of [exceptionButton, pauseButton, closeButton]) {
      expect(button.style.width).toBe("220px");
      expect(button.style.maxWidth).toBe("100%");
    }
    fireEvent.click(exceptionButton);
    fireEvent.click(pauseButton);
    fireEvent.click(closeButton);
    expect(onExceptions).toHaveBeenCalledOnce();
    expect(onPause).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
