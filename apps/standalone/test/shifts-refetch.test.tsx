import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as OfficeQuery from "../src/office/office-query.js";
import { officeKeys } from "../src/office/office-query.js";
import type { OfficeShift } from "../src/host/protocol.js";
import {
  freezeToday,
  openShifts,
  PLANNED,
  pickDate,
  shiftRows,
  shiftsSession,
} from "./support/shifts.js";

const SESSION_TOKEN = "office-session-token";

// The office's query client is made inside `Office`; a write of tasks 4–6 reads
// the lists again through it, so the test holds the one the page runs on.
const held = vi.hoisted(() => ({ client: undefined as QueryClient | undefined }));
vi.mock("../src/office/office-query.js", async (importOriginal) => {
  const original = await importOriginal<typeof OfficeQuery>();
  return {
    ...original,
    createOfficeQueryClient: () => {
      held.client = original.createOfficeQueryClient();
      return held.client;
    },
  };
});

function numbered(count: number): OfficeShift[] {
  return Array.from({ length: count }, (_, n) => ({
    ...PLANNED,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    number: `OCT26-${String(n + 1).padStart(3, "0")}`,
  }));
}

/** Reads every list of shifts again, as a write does. */
async function invalidateShifts(): Promise<void> {
  const client = held.client;
  if (client === undefined) throw new Error("the office has no query client");
  await act(async () => {
    await client.invalidateQueries({ queryKey: officeKeys.shifts });
  });
}

describe("office shifts: the list read again", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never shows an empty page when the list is read again shorter than the page it is on", async () => {
    const session = shiftsSession(numbered(11));
    await openShifts(session);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Страницы списка смен" })).getByRole("button", {
        name: "Вперёд",
      }),
    );
    expect(shiftRows()).toHaveLength(1);
    session.api.listShifts.mockResolvedValue(numbered(10));
    await invalidateShifts();
    await waitFor(() => expect(shiftRows()).toHaveLength(10));
    expect(screen.queryByRole("navigation", { name: "Страницы списка смен" })).toBeNull();
    expect(screen.queryByText("Ничего не найдено. Измените отбор.")).toBeNull();
  });

  it("reads the list of a chosen period again too, with the same dates", async () => {
    const session = shiftsSession();
    await openShifts(session);
    pickDate("Дата производства с", "1 сентября 2026", 1);
    pickDate("Дата производства по", "8 октября 2026");
    await waitFor(() => expect(shiftRows()).toHaveLength(3));
    expect(session.api.listShifts).toHaveBeenCalledTimes(2);
    session.api.listShifts.mockResolvedValue([PLANNED]);
    await invalidateShifts();
    await waitFor(() => expect(shiftRows()).toHaveLength(1));
    expect(session.api.listShifts).toHaveBeenLastCalledWith(SESSION_TOKEN, {
      from: "2026-09-01",
      to: "2026-10-08",
    });
  });
});
