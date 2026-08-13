import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BoxFillInstrument } from "../src/ui/work/BoxFillInstrument.js";
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
        capacity={null}
        canUndo={false}
        labels={{
          title: "Open box",
          absent: "No open box",
          count: "Items",
          capacityUnknown: "Capacity not set",
          close: "Close box",
          undo: "Undo last scan",
          clear: "Clear box",
        }}
        {...callbacks}
      />,
    );
    expect(screen.getByText("No open box")).toBeDefined();
    expect(screen.queryByRole("progressbar")).toBeNull();

    rerender(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 12 }}
        capacity={0}
        canUndo={false}
        labels={{
          title: "Open box",
          absent: "No open box",
          count: "Items",
          capacityUnknown: "Capacity not set",
          close: "Close box",
          undo: "Undo last scan",
          clear: "Clear box",
        }}
        {...callbacks}
      />,
    );
    expect(screen.getByText("Capacity not set")).toBeDefined();
    expect(screen.queryByRole("progressbar")).toBeNull();

    rerender(
      <BoxFillInstrument
        box={{ boxId: "b1", itemCount: 12 }}
        capacity={10}
        canUndo
        labels={{
          title: "Open box",
          absent: "No open box",
          count: "Items",
          capacityUnknown: "Capacity not set",
          close: "Close box",
          undo: "Undo last scan",
          clear: "Clear box",
        }}
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
