import type { InventoryCorrectionBatchSelection, InventoryEvidenceFilter } from "./schemas.js";

export interface SelectableEvidenceEvent {
  eventId: string;
  affectedCodeCount: number;
}

export interface ExplicitSelectionState {
  mode: "explicit";
  selected: ReadonlyMap<string, number>;
  selectedEventCount: number;
  selectedCodeCount: number;
}

export interface AllMatchingSelectionInput {
  filter: InventoryEvidenceFilter;
  total: number;
  affectedCodeCount: number;
}

export interface AllMatchingSelectionState {
  mode: "all_matching";
  filter: InventoryEvidenceFilter;
  totalEventCount: number;
  totalCodeCount: number;
  excluded: ReadonlyMap<string, number>;
  selectedEventCount: number;
  selectedCodeCount: number;
}

export type InventoryCorrectionSelectionState = ExplicitSelectionState | AllMatchingSelectionState;

export function createExplicitSelection(): ExplicitSelectionState {
  return {
    mode: "explicit",
    selected: new Map(),
    selectedEventCount: 0,
    selectedCodeCount: 0,
  };
}

export function clearSelection(_state?: InventoryCorrectionSelectionState): ExplicitSelectionState {
  return createExplicitSelection();
}

export function toggleEvent(
  state: InventoryCorrectionSelectionState,
  event: SelectableEvidenceEvent,
): InventoryCorrectionSelectionState {
  if (state.mode === "explicit") {
    const selected = new Map(state.selected);
    if (selected.has(event.eventId)) selected.delete(event.eventId);
    else selected.set(event.eventId, event.affectedCodeCount);
    return explicitSelection(selected);
  }

  const excluded = new Map(state.excluded);
  if (excluded.has(event.eventId)) excluded.delete(event.eventId);
  else excluded.set(event.eventId, event.affectedCodeCount);
  return allMatchingSelection(state, excluded);
}

export function toggleVisiblePage(
  state: InventoryCorrectionSelectionState,
  events: readonly SelectableEvidenceEvent[],
): InventoryCorrectionSelectionState {
  if (events.length === 0) return state;
  const allSelected = events.every((event) => isEventSelected(state, event.eventId));
  let next = state;
  for (const event of events) {
    if (isEventSelected(next, event.eventId) === allSelected) {
      next = toggleEvent(next, event);
    }
  }
  return next;
}

export function selectAllMatching(input: AllMatchingSelectionInput): AllMatchingSelectionState {
  return {
    mode: "all_matching",
    filter: { ...input.filter },
    totalEventCount: input.total,
    totalCodeCount: input.affectedCodeCount,
    excluded: new Map(),
    selectedEventCount: input.total,
    selectedCodeCount: input.affectedCodeCount,
  };
}

export function isEventSelected(
  state: InventoryCorrectionSelectionState,
  eventId: string,
): boolean {
  return state.mode === "explicit" ? state.selected.has(eventId) : !state.excluded.has(eventId);
}

export function serializeSelection(
  state: InventoryCorrectionSelectionState,
): InventoryCorrectionBatchSelection {
  if (state.mode === "explicit") {
    return { mode: "explicit", eventIds: [...state.selected.keys()] };
  }
  return {
    mode: "all_matching",
    filter: state.filter,
    excludedEventIds: [...state.excluded.keys()],
  };
}

function explicitSelection(selected: ReadonlyMap<string, number>): ExplicitSelectionState {
  return {
    mode: "explicit",
    selected,
    selectedEventCount: selected.size,
    selectedCodeCount: [...selected.values()].reduce((sum, count) => sum + count, 0),
  };
}

function allMatchingSelection(
  state: AllMatchingSelectionState,
  excluded: ReadonlyMap<string, number>,
): AllMatchingSelectionState {
  const excludedCodeCount = [...excluded.values()].reduce((sum, count) => sum + count, 0);
  return {
    ...state,
    excluded,
    selectedEventCount: state.totalEventCount - excluded.size,
    selectedCodeCount: state.totalCodeCount - excludedCodeCount,
  };
}
