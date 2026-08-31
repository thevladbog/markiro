import { describe, expect, it } from "vitest";

import {
  clearSelection,
  createExplicitSelection,
  selectAllMatching,
  serializeSelection,
  toggleEvent,
  toggleVisiblePage,
} from "../src/pages/inventory/inventory-correction-selection.js";

const FIRST_EVENT = "11111111-1111-4111-8111-111111111111";
const SECOND_EVENT = "22222222-2222-4222-8222-222222222222";
const THIRD_EVENT = "33333333-3333-4333-8333-333333333333";

const page = [
  { eventId: FIRST_EVENT, affectedCodeCount: 20 },
  { eventId: SECOND_EVENT, affectedCodeCount: 1 },
] as const;

describe("inventory correction selection", () => {
  it("selects and clears a visible page without mutating earlier state", () => {
    const empty = createExplicitSelection();
    const selected = toggleVisiblePage(empty, page);

    expect(empty.selected.size).toBe(0);
    expect(selected).toMatchObject({
      mode: "explicit",
      selectedEventCount: 2,
      selectedCodeCount: 21,
    });
    expect(serializeSelection(selected)).toEqual({
      mode: "explicit",
      eventIds: [FIRST_EVENT, SECOND_EVENT],
    });

    expect(toggleVisiblePage(selected, page)).toEqual(createExplicitSelection());
  });

  it("keeps explicitly selected rows from other pages", () => {
    const firstPage = toggleVisiblePage(createExplicitSelection(), page);
    const secondPage = toggleVisiblePage(firstPage, [
      { eventId: THIRD_EVENT, affectedCodeCount: 3 },
    ]);

    expect(secondPage.selectedEventCount).toBe(3);
    expect(secondPage.selectedCodeCount).toBe(24);
    expect(toggleEvent(secondPage, page[0])).toMatchObject({
      selectedEventCount: 2,
      selectedCodeCount: 4,
    });
  });

  it("represents all matching events with only a filter snapshot and exclusions", () => {
    const filter = {
      scope: "discrepancies" as const,
      search: "0468",
      discrepancyCategory: "unknown" as const,
    };
    const selected = selectAllMatching({
      filter,
      total: 2582,
      affectedCodeCount: 2600,
    });
    const excluded = toggleEvent(selected, {
      eventId: FIRST_EVENT,
      affectedCodeCount: 20,
    });

    expect(excluded).toMatchObject({
      mode: "all_matching",
      selectedEventCount: 2581,
      selectedCodeCount: 2580,
    });
    expect(serializeSelection(selected)).toEqual({
      mode: "all_matching",
      filter,
      excludedEventIds: [],
    });
    expect(serializeSelection(excluded)).toEqual({
      mode: "all_matching",
      filter,
      excludedEventIds: [FIRST_EVENT],
    });
    expect(toggleEvent(excluded, page[0])).toEqual(selected);
  });

  it("clears either selection mode to an empty explicit selection", () => {
    const selected = selectAllMatching({
      filter: { scope: "all" },
      total: 2,
      affectedCodeCount: 21,
    });

    expect(clearSelection(selected)).toEqual(createExplicitSelection());
  });
});
