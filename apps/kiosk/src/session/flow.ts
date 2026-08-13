import type { CreateOrderResultDto } from "../api/types.js";
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
  reason: "buy" | "writeoff";
  writeoffReasonId: string | null;
}

type ActiveScreen = "cart" | "operation" | "reason" | "confirmation";

export type KioskFlowState =
  | { screen: "pairing" }
  | { screen: "login" }
  | { screen: ActiveScreen; session: ActiveKioskSession }
  | {
      screen: "outcome";
      session: ActiveKioskSession;
      deviceSeq: number;
      result: CreateOrderResultDto | null;
      outcome: KioskOutcome;
    };

export type KioskFlowAction =
  | { type: "paired" }
  | { type: "unpaired" }
  | { type: "sessionStarted"; session: ActiveKioskSession }
  | { type: "cartChanged"; cart: CartState }
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

function withSession(
  state: Extract<KioskFlowState, { session: ActiveKioskSession }>,
  session: ActiveKioskSession,
): KioskFlowState {
  return { ...state, session };
}

/** Pure screen/session state machine. Scanner, storage, clocks and network stay outside it. */
export function kioskFlowReducer(state: KioskFlowState, action: KioskFlowAction): KioskFlowState {
  if (action.type === "unpaired") return { screen: "pairing" };
  if (
    action.type === "finish" ||
    action.type === "cancelConfirmed" ||
    action.type === "logoutConfirmed" ||
    action.type === "idleReset"
  )
    return { screen: "login" };

  switch (action.type) {
    case "paired":
      return state.screen === "pairing" ? { screen: "login" } : state;
    case "sessionStarted":
      return state.screen === "login" ? { screen: "cart", session: action.session } : state;
    case "cartChanged":
      if (!("session" in state) || state.screen === "outcome") return state;
      return withSession(state, {
        ...state.session,
        cart: action.cart,
        reason: action.cart.reason,
        writeoffReasonId: action.cart.writeoffReasonId,
      });
    case "continue":
      if (!("session" in state)) return state;
      if (state.screen === "cart") {
        if (state.session.cart.items.length === 0) return state;
        return state.session.employee.canWriteoff
          ? { screen: "operation", session: state.session }
          : {
              screen: "confirmation",
              session: { ...state.session, reason: "buy", writeoffReasonId: null },
            };
      }
      if (state.screen === "reason") {
        if (state.session.reason !== "writeoff" || state.session.writeoffReasonId === null)
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
          session: { ...state.session, reason: "writeoff", writeoffReasonId: null },
        };
      }
      return {
        screen: "confirmation",
        session: { ...state.session, reason: "buy", writeoffReasonId: null },
      };
    case "chooseWriteoffReason":
      if (state.screen !== "reason" || action.id.length === 0) return state;
      return withSession(state, { ...state.session, writeoffReasonId: action.id });
    case "back":
      if (!("session" in state) || state.screen === "outcome") return state;
      if (state.screen === "operation") return { screen: "cart", session: state.session };
      if (state.screen === "reason") return { screen: "operation", session: state.session };
      if (state.screen === "confirmation") {
        if (state.session.reason === "writeoff")
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
  }
}
