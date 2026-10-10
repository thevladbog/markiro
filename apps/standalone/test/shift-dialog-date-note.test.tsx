import type { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostError } from "../src/host/client.js";
import type * as OfficeQuery from "../src/office/office-query.js";
import { officeKeys } from "../src/office/office-query.js";
import { ORG_PROFILE } from "./support/office.js";
import { freezeToday, openShifts, shiftsSession } from "./support/shifts.js";

// The office's query client is made inside `Office`; the profile is read again through it.
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

const LOCAL_NOTE = "Часовой пояс организации не загрузился: «сегодня» — по часам этого ПК.";

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Новая смена" });
}

async function openCreate(session: ReturnType<typeof shiftsSession>): Promise<void> {
  await openShifts(session);
  fireEvent.click(screen.getByRole("button", { name: "Запланировать смену" }));
  await screen.findByRole("dialog", { name: "Новая смена" });
  await waitFor(() =>
    expect((within(dialog()).getByLabelText("Товар") as HTMLSelectElement).disabled).toBe(false),
  );
}

/** Reads the organization's profile again, as a later visit to the page would. */
async function refetchOrg(): Promise<void> {
  const client = held.client;
  if (client === undefined) throw new Error("the office has no query client");
  await act(async () => {
    await client.invalidateQueries({ queryKey: officeKeys.org });
  });
}

function dateText(): string | null {
  return within(dialog()).getByRole("button", { name: "Дата производства" }).textContent;
}

describe("office shifts: the note under the production date of a new shift", () => {
  beforeEach(() => {
    localStorage.removeItem("markiro.theme");
    freezeToday();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays without a note when the profile that gave the date is read again and fails", async () => {
    const session = shiftsSession();
    await openCreate(session);
    expect(dateText()).toBe("9 октября 2026");
    expect(within(dialog()).queryByText(LOCAL_NOTE)).toBeNull();
    session.api.getOrg.mockRejectedValue(
      new HostError({ kind: "api", code: "internal", status: 500, message: "x" }),
    );
    await refetchOrg();
    await waitFor(() => expect(session.api.getOrg).toHaveBeenCalledTimes(2));
    expect(within(dialog()).queryByText(LOCAL_NOTE)).toBeNull();
    expect(dateText()).toBe("9 октября 2026");
  });

  it("keeps the note under the PC's date when the profile that failed is read again and arrives", async () => {
    const session = shiftsSession();
    session.api.getOrg.mockRejectedValue(
      new HostError({ kind: "api", code: "internal", status: 500, message: "x" }),
    );
    await openCreate(session);
    expect(within(dialog()).getByText(LOCAL_NOTE)).toBeTruthy();
    session.api.getOrg.mockResolvedValue({ ...ORG_PROFILE, timeZone: "Asia/Kamchatka" });
    await refetchOrg();
    await waitFor(() => expect(session.api.getOrg).toHaveBeenCalledTimes(2));
    // The value was this PC's date and still is: the note about it stays.
    expect(within(dialog()).getByText(LOCAL_NOTE)).toBeTruthy();
    expect(dateText()).toBe("9 октября 2026");
  });
});
