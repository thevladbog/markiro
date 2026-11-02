import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { OfficeShift } from "../src/host/protocol.js";
import { ACTIVE, SHARED, openShifts, shiftsSession } from "./support/shifts.js";

async function summary(shift: OfficeShift) {
  const session = shiftsSession([shift]);
  session.api.getShift.mockResolvedValue(shift);
  await openShifts(session);
  fireEvent.click(screen.getByRole("link", { name: `Карточка смены ${shift.number}` }));
  const panel = await screen.findByRole("dialog", { name: `Смена ${shift.number}` });
  await within(panel).findByRole("region", { name: "Выпуск и завершение" });
  return panel;
}

const COMPLETE: OfficeShift = {
  ...SHARED,
  plannedQty: 8,
  totals: {
    ...SHARED.totals,
    acceptedUnits: 8,
    unitsInClosedBoxes: 8,
    closedBoxes: 4,
    openBoxes: 0,
  },
  participants: (SHARED.participants ?? []).map((part) => ({ ...part, state: "closed" })),
};

describe("approved shift summary", () => {
  it("shows a real plan percentage and independent packaging/part checks", async () => {
    const panel = await summary(COMPLETE);
    const progress = within(panel).getByRole("progressbar", { name: "Выполнение плана" });
    expect(progress.getAttribute("aria-valuenow")).toBe("100");
    expect(within(panel).getByText("Коды упакованы")).toBeTruthy();
    expect(within(panel).getByText("Все части закрыты")).toBeTruthy();
  });

  it.each([null, 0])("does not infer a percentage for plan %s", async (plannedQty) => {
    const panel = await summary({ ...ACTIVE, plannedQty });
    expect(within(panel).queryByRole("progressbar", { name: "Выполнение плана" })).toBeNull();
  });

  it("keeps incomplete packaging visible even when the plan is complete", async () => {
    const panel = await summary({
      ...COMPLETE,
      totals: { ...COMPLETE.totals, unitsInClosedBoxes: 6, openBoxes: 1 },
    });
    expect(within(panel).getByText("Есть неупакованные коды")).toBeTruthy();
    expect(within(panel).queryByText("Коды упакованы")).toBeNull();
  });

  it("does not require packaging for validation", async () => {
    const panel = await summary({ ...COMPLETE, mode: "validation" });
    expect(within(panel).queryByText("Коды упакованы")).toBeNull();
    expect(within(panel).queryByText("Есть неупакованные коды")).toBeNull();
  });

  it("does not claim closed parts for an older host without participants", async () => {
    const panel = await summary(ACTIVE);
    expect(within(panel).queryByText("Все части закрыты")).toBeNull();
  });
  it("does not complete packaging before the first code", async () => {
    const panel = await summary({
      ...COMPLETE,
      totals: {
        ...COMPLETE.totals,
        acceptedUnits: 0,
        unitsInClosedBoxes: 0,
        closedBoxes: 0,
        openBoxes: 0,
      },
    });
    expect(within(panel).getByText("Коды ещё не приняты")).toBeTruthy();
    expect(within(panel).queryByText("Коды упакованы")).toBeNull();
  });
  it("retains over-plan output without overflowing the progress range", async () => {
    const panel = await summary({ ...COMPLETE, plannedQty: 4 });
    const progress = within(panel).getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("100");
    expect(progress.getAttribute("aria-valuetext")).toContain("200%");
  });
  it("does not count a left participant as closed", async () => {
    const panel = await summary({
      ...COMPLETE,
      participants: (COMPLETE.participants ?? []).map((p, i) => ({
        ...p,
        state: i === 0 ? "left" : "closed",
      })),
    });
    expect(within(panel).queryByText("Все части закрыты")).toBeNull();
  });
  it.each([true, false])(
    "shows device shares only for reconciled totals: %s",
    async (reconciled) => {
      const panel = await summary({
        ...COMPLETE,
        byDevice: (COMPLETE.byDevice ?? []).map((p) => ({ ...p, accepted: reconciled ? 4 : 3 })),
      });
      expect(panel.querySelectorAll(".shift-contributions__share")).toHaveLength(
        reconciled ? 2 : 0,
      );
    },
  );
});
