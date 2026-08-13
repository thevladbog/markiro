import type { CreateOrderDto, CreateOrderResultDto } from "../api/types.js";
import type { CartItem, CartState } from "./cart.js";

export type KioskScreen =
  "pairing" | "login" | "cart" | "operation" | "reason" | "confirmation" | "outcome";

export type KioskOutcome =
  | { kind: "accepted"; orderNo: string; bottleCount: number; totalKopecks: number | null }
  | { kind: "queued"; deviceSeq: number; bottleCount: number }
  | { kind: "rejected"; title: string; message: string; bottleCount: number | null }
  | {
      kind: "partial";
      orderNo: string;
      acceptedBottleCount: number;
      rejectedLines: CartItem[];
    };

export interface KioskEmployee {
  id: string;
  fullName: string;
  limitMode: "limited" | "unlimited";
  dayLimit: number;
  canWriteoff: boolean;
}

export interface ActiveKioskSession {
  /** Monotonic UI instance identity; it is not sent to the server. */
  id: number;
  /** Digest proof produced by badge admission. Raw badge data never enters this model. */
  badgeDigest: string;
  employee: KioskEmployee;
  cart: CartState;
}

type ActiveScreen = "cart" | "operation" | "reason" | "confirmation";
type ActiveKioskFlowState = {
  [Screen in ActiveScreen]: { screen: Screen; session: ActiveKioskSession };
}[ActiveScreen];

export type KioskFlowState =
  | { screen: "pairing" }
  | { screen: "login" }
  | ActiveKioskFlowState
  | {
      screen: "outcome";
      session: ActiveKioskSession;
      deviceSeq: number;
      result: CreateOrderResultDto | null;
      outcome: KioskOutcome;
    };

export interface ConfirmedKioskFlowState {
  screen: "confirmation";
  session: ActiveKioskSession;
}

export type KioskFlowAction =
  | { type: "paired" }
  | { type: "unpaired" }
  | { type: "sessionStarted"; session: ActiveKioskSession }
  | { type: "cartChanged"; cart: CartState }
  | { type: "legacySubmit"; cart: CartState }
  | { type: "submitFailed" }
  | { type: "continue" }
  | { type: "chooseOperation"; reason: "buy" | "writeoff" }
  | { type: "chooseWriteoffReason"; id: string }
  | { type: "back" }
  | {
      type: "submitted";
      deviceSeq: number;
      result: CreateOrderResultDto | null;
      outcome: KioskOutcome;
    }
  | { type: "finish" }
  | { type: "cancelConfirmed" }
  | { type: "logoutConfirmed" }
  | { type: "idleReset" };

export const initialKioskFlowState: KioskFlowState = Object.freeze({ screen: "pairing" });

/** Exact wire draft from the reducer-confirmed canonical session only. */
export function createConfirmedOrderBody(
  state: ConfirmedKioskFlowState,
  deviceSeq: number,
  createdAt: string,
): CreateOrderDto {
  return {
    deviceSeq,
    badgeDigest: state.session.badgeDigest,
    reason: state.session.cart.reason,
    writeoffReasonId: state.session.cart.writeoffReasonId,
    items: state.session.cart.items.map((item) => ({ rawKm: item.rawKm })),
    createdAt,
  };
}

function withSession(
  state: Extract<KioskFlowState, { session: ActiveKioskSession }>,
  session: ActiveKioskSession,
): KioskFlowState {
  return { ...state, session };
}

/** Pure screen/session state machine. Scanner, storage, clocks and network stay outside it. */
export function kioskFlowReducer(state: KioskFlowState, action: KioskFlowAction): KioskFlowState {
  if (action.type === "unpaired") return { screen: "pairing" };

  switch (action.type) {
    case "paired":
      return state.screen === "pairing" ? { screen: "login" } : state;
    case "sessionStarted":
      return state.screen === "login" ? { screen: "cart", session: action.session } : state;
    case "cartChanged":
      return state.screen === "cart"
        ? withSession(state, { ...state.session, cart: action.cart })
        : state;
    case "legacySubmit": {
      if (state.screen !== "cart" || action.cart.items.length === 0) return state;
      const cart = state.session.employee.canWriteoff
        ? action.cart
        : { ...action.cart, reason: "buy" as const, writeoffReasonId: null };
      if (cart.reason === "writeoff" && cart.writeoffReasonId === null) return state;
      return {
        screen: "confirmation",
        session: {
          ...state.session,
          cart:
            cart.reason === "buy" && cart.writeoffReasonId !== null
              ? { ...cart, writeoffReasonId: null }
              : cart,
        },
      };
    }
    case "submitFailed":
      return state.screen === "confirmation" ? { screen: "cart", session: state.session } : state;
    case "continue":
      if (!("session" in state)) return state;
      if (state.screen === "cart") {
        if (state.session.cart.items.length === 0) return state;
        return state.session.employee.canWriteoff
          ? { screen: "operation", session: state.session }
          : {
              screen: "confirmation",
              session: {
                ...state.session,
                cart: { ...state.session.cart, reason: "buy", writeoffReasonId: null },
              },
            };
      }
      if (state.screen === "reason") {
        if (
          state.session.cart.reason !== "writeoff" ||
          state.session.cart.writeoffReasonId === null
        )
          return state;
        return { screen: "confirmation", session: state.session };
      }
      return state;
    case "chooseOperation":
      if (state.screen !== "operation") return state;
      if (action.reason === "writeoff") {
        if (!state.session.employee.canWriteoff) return state;
        return {
          screen: "reason",
          session: {
            ...state.session,
            cart: { ...state.session.cart, reason: "writeoff", writeoffReasonId: null },
          },
        };
      }
      return {
        screen: "confirmation",
        session: {
          ...state.session,
          cart: { ...state.session.cart, reason: "buy", writeoffReasonId: null },
        },
      };
    case "chooseWriteoffReason":
      if (state.screen !== "reason" || action.id.length === 0) return state;
      return withSession(state, {
        ...state.session,
        cart: { ...state.session.cart, writeoffReasonId: action.id },
      });
    case "back":
      if (!("session" in state) || state.screen === "outcome") return state;
      if (state.screen === "operation") return { screen: "cart", session: state.session };
      if (state.screen === "reason") return { screen: "operation", session: state.session };
      if (state.screen === "confirmation") {
        if (state.session.cart.reason === "writeoff")
          return { screen: "reason", session: state.session };
        return {
          screen: state.session.employee.canWriteoff ? "operation" : "cart",
          session: state.session,
        };
      }
      return state;
    case "submitted":
      return state.screen === "confirmation"
        ? {
            screen: "outcome",
            session: state.session,
            deviceSeq: action.deviceSeq,
            result: action.result,
            outcome: action.outcome,
          }
        : state;
    case "finish":
      return state.screen === "outcome" ? { screen: "login" } : state;
    case "cancelConfirmed":
    case "logoutConfirmed":
    case "idleReset":
      return "session" in state ? { screen: "login" } : state;
  }
}
