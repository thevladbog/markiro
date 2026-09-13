import type { BudgetLine, GrantEventType } from "./types.js";

/** Version 1 productive dimensions. These names are a TS/Kotlin wire contract. */
export const GRANT_EVENT_DIMENSIONS = {
  "shift.scan.v1": ["events", "units"],
  "shift.box.close.v1": ["events", "containers"],
  "shift.pallet.close.v1": ["events", "containers"],
  "shift.label.prepare.v1": ["events", "units"],
  "shift.close.v1": ["events"],
  "inventory.scan.v1": ["events", "units"],
  "inventory.repack.v1": ["events", "units"],
  "inventory.box.close.v1": ["events", "containers"],
  "inventory.close.v1": ["events"],
  "pickup.complete.v1": ["events", "units", "containers"],
} as const satisfies Record<GrantEventType, readonly ("events" | "units" | "containers")[]>;
export interface GrantEventBounds {
  maxEvents: number;
  maxUnits?: number | undefined;
  maxContainers?: number | undefined;
}
const valid = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;
export function grantEventBudget(
  event: GrantEventType,
  bounds: GrantEventBounds,
): BudgetLine[] | null {
  const result: BudgetLine[] = [];
  for (const dimension of GRANT_EVENT_DIMENSIONS[event]) {
    const maximum =
      dimension === "events"
        ? bounds.maxEvents
        : dimension === "units"
          ? bounds.maxUnits
          : bounds.maxContainers;
    if (!valid(maximum)) return null;
    result.push({
      id: `${event}:${dimension}`,
      unit: dimension === "events" ? "event" : dimension === "units" ? "unit" : "container",
      maximum,
    });
  }
  return result;
}
/** Caller must derive facts from the persisted event/line/container owner, never an API count. */
export function grantEventCost(
  event: GrantEventType,
  facts: { units?: number; containers?: number },
): Record<string, number> | null {
  const result: Record<string, number> = {};
  for (const dimension of GRANT_EVENT_DIMENSIONS[event]) {
    const cost =
      dimension === "events" ? 1 : dimension === "units" ? facts.units : facts.containers;
    if (!valid(cost)) return null;
    result[`${event}:${dimension}`] = cost;
  }
  return result;
}
