export type InventoryRepackingPhase =
  "awaiting-old-box" | "scanning" | "closed-pending-print" | "invalidated";

export type InventoryRepackObservationClassification =
  "eligible" | "protected" | "known-ineligible" | "unknown" | "invalid" | "duplicate";

export interface InventoryRepackMembership {
  readonly eventId: string;
  readonly codeHash: string;
  readonly position: number;
  readonly observedAt: string;
  readonly productionDate: string;
  readonly sourceParentSscc: string | null;
  readonly sourceParentMismatch: boolean;
}

export interface InventoryRepackBoxState {
  readonly boxId: string;
  readonly oldSsccContext: string;
  readonly newSscc: string;
  readonly productionDate: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly invalidatedAt: string | null;
  readonly items: readonly InventoryRepackMembership[];
}

export interface InventoryRepackingState {
  readonly phase: InventoryRepackingPhase;
  readonly ownerDeviceId: string;
  readonly capacity: number;
  readonly activeProductionDate: string;
  readonly oldSsccContext: string | null;
  readonly box: InventoryRepackBoxState | null;
}

export type InventoryRepackingAction =
  | {
      readonly type: "select-old-box";
      readonly deviceId: string;
      readonly oldSscc: string;
      readonly boxId: string;
      readonly newSscc: string;
      readonly openedAt: string;
    }
  | {
      readonly type: "observe-item";
      readonly deviceId: string;
      readonly observedAt: string;
      readonly item: {
        readonly eventId: string;
        readonly codeHash: string;
        readonly classification: InventoryRepackObservationClassification;
        readonly observedProductionDate: string;
        readonly sourceParentSscc: string | null;
      };
    }
  | {
      readonly type: "change-active-date";
      readonly deviceId: string;
      readonly productionDate: string;
    }
  | { readonly type: "remove-last"; readonly deviceId: string; readonly removedAt: string }
  | { readonly type: "clear-open-box"; readonly deviceId: string; readonly clearedAt: string }
  | {
      readonly type: "close-incomplete";
      readonly deviceId: string;
      readonly confirmed: boolean;
      readonly closedAt: string;
    }
  | {
      readonly type: "authoritative-conflict";
      readonly affectedBoxIds: readonly string[];
      readonly invalidatedAt: string;
    };

export type InventoryRepackingEffect =
  | { readonly kind: "old-box-selected" }
  | {
      readonly kind: "observation-only";
      readonly classification: InventoryRepackObservationClassification;
      readonly reason?: "BOX_DATE_MISMATCH";
    }
  | {
      readonly kind: "item-added";
      readonly position: number;
      readonly sourceParentMismatch: boolean;
    }
  | {
      readonly kind: "capacity-closed";
      readonly position: number;
      readonly sourceParentMismatch: boolean;
    }
  | { readonly kind: "membership-replay"; readonly position: number }
  | { readonly kind: "date-changed" }
  | { readonly kind: "last-item-removed"; readonly eventId: string }
  | { readonly kind: "box-cleared"; readonly removedCount: number }
  | { readonly kind: "incomplete-closed" }
  | { readonly kind: "box-invalidated" }
  | { readonly kind: "conflict-unrelated" };

export type InventoryRepackingFailureReason =
  | "OLD_BOX_REQUIRED"
  | "OLD_BOX_ALREADY_SELECTED"
  | "FOREIGN_BOX_OWNER"
  | "PRINT_PENDING"
  | "BOX_INVALIDATED"
  | "NON_EMPTY_BOX_DATE_FROZEN"
  | "CONFIRM_INCOMPLETE_CLOSE"
  | "BOX_EMPTY";

export type InventoryRepackingResult =
  | {
      readonly ok: true;
      readonly state: InventoryRepackingState;
      readonly effect: InventoryRepackingEffect;
    }
  | {
      readonly ok: false;
      readonly state: InventoryRepackingState;
      readonly reason: InventoryRepackingFailureReason;
    };

export function createInventoryRepackingState(input: {
  ownerDeviceId: string;
  capacity: number;
  activeProductionDate: string;
}): InventoryRepackingState {
  if (!Number.isSafeInteger(input.capacity) || input.capacity <= 0) {
    throw new Error("inventory repack capacity must be a positive safe integer");
  }
  return {
    phase: "awaiting-old-box",
    ownerDeviceId: input.ownerDeviceId,
    capacity: input.capacity,
    activeProductionDate: input.activeProductionDate,
    oldSsccContext: null,
    box: null,
  };
}

function fail(
  state: InventoryRepackingState,
  reason: InventoryRepackingFailureReason,
): InventoryRepackingResult {
  return { ok: false, reason, state };
}

function requireOwnedOpenBox(
  state: InventoryRepackingState,
  deviceId: string,
): InventoryRepackingFailureReason | null {
  if (deviceId !== state.ownerDeviceId) return "FOREIGN_BOX_OWNER";
  if (state.phase === "closed-pending-print") return "PRINT_PENDING";
  if (state.phase === "invalidated") return "BOX_INVALIDATED";
  if (state.phase !== "scanning" || !state.box) return "OLD_BOX_REQUIRED";
  return null;
}

export function reduceInventoryRepacking(
  state: InventoryRepackingState,
  action: InventoryRepackingAction,
): InventoryRepackingResult {
  if (action.type === "authoritative-conflict") {
    if (!state.box || !action.affectedBoxIds.includes(state.box.boxId)) {
      return { ok: true, state, effect: { kind: "conflict-unrelated" } };
    }
    if (state.phase === "invalidated") {
      return { ok: true, state, effect: { kind: "box-invalidated" } };
    }
    return {
      ok: true,
      state: {
        ...state,
        phase: "invalidated",
        box: { ...state.box, invalidatedAt: action.invalidatedAt },
      },
      effect: { kind: "box-invalidated" },
    };
  }

  if (action.type === "select-old-box") {
    if (action.deviceId !== state.ownerDeviceId) return fail(state, "FOREIGN_BOX_OWNER");
    if (state.phase === "closed-pending-print") return fail(state, "PRINT_PENDING");
    if (state.phase === "invalidated") return fail(state, "BOX_INVALIDATED");
    if (state.phase !== "awaiting-old-box") return fail(state, "OLD_BOX_ALREADY_SELECTED");
    return {
      ok: true,
      state: {
        ...state,
        phase: "scanning",
        oldSsccContext: action.oldSscc,
        box: {
          boxId: action.boxId,
          oldSsccContext: action.oldSscc,
          newSscc: action.newSscc,
          productionDate: state.activeProductionDate,
          openedAt: action.openedAt,
          closedAt: null,
          invalidatedAt: null,
          items: [],
        },
      },
      effect: { kind: "old-box-selected" },
    };
  }

  const ownershipFailure = requireOwnedOpenBox(state, action.deviceId);
  if (ownershipFailure) return fail(state, ownershipFailure);
  const box = state.box;
  if (!box) return fail(state, "OLD_BOX_REQUIRED");

  if (action.type === "change-active-date") {
    if (box.items.length > 0) return fail(state, "NON_EMPTY_BOX_DATE_FROZEN");
    return {
      ok: true,
      state: {
        ...state,
        activeProductionDate: action.productionDate,
        box: { ...box, productionDate: action.productionDate },
      },
      effect: { kind: "date-changed" },
    };
  }

  if (action.type === "observe-item") {
    if (action.item.classification !== "eligible") {
      return {
        ok: true,
        state,
        effect: { kind: "observation-only", classification: action.item.classification },
      };
    }
    if (action.item.observedProductionDate !== box.productionDate) {
      return {
        ok: true,
        state,
        effect: {
          kind: "observation-only",
          classification: "eligible",
          reason: "BOX_DATE_MISMATCH",
        },
      };
    }
    const existing = box.items.find((item) => item.codeHash === action.item.codeHash);
    if (existing) {
      return {
        ok: true,
        state,
        effect: { kind: "membership-replay", position: existing.position },
      };
    }
    const sourceParentMismatch = action.item.sourceParentSscc !== box.oldSsccContext;
    const position = box.items.length + 1;
    const nextBox: InventoryRepackBoxState = {
      ...box,
      items: [
        ...box.items,
        {
          eventId: action.item.eventId,
          codeHash: action.item.codeHash,
          position,
          observedAt: action.observedAt,
          productionDate: action.item.observedProductionDate,
          sourceParentSscc: action.item.sourceParentSscc,
          sourceParentMismatch,
        },
      ],
      closedAt: position === state.capacity ? action.observedAt : null,
    };
    return {
      ok: true,
      state: {
        ...state,
        phase: position === state.capacity ? "closed-pending-print" : "scanning",
        box: nextBox,
      },
      effect:
        position === state.capacity
          ? { kind: "capacity-closed", position, sourceParentMismatch }
          : { kind: "item-added", position, sourceParentMismatch },
    };
  }

  if (action.type === "remove-last") {
    const last = box.items.at(-1);
    if (!last) return fail(state, "BOX_EMPTY");
    return {
      ok: true,
      state: { ...state, box: { ...box, items: box.items.slice(0, -1) } },
      effect: { kind: "last-item-removed", eventId: last.eventId },
    };
  }

  if (action.type === "clear-open-box") {
    return {
      ok: true,
      state: { ...state, box: { ...box, items: [] } },
      effect: { kind: "box-cleared", removedCount: box.items.length },
    };
  }

  if (!action.confirmed) return fail(state, "CONFIRM_INCOMPLETE_CLOSE");
  if (box.items.length === 0) return fail(state, "BOX_EMPTY");
  return {
    ok: true,
    state: {
      ...state,
      phase: "closed-pending-print",
      box: { ...box, closedAt: action.closedAt },
    },
    effect: { kind: "incomplete-closed" },
  };
}
