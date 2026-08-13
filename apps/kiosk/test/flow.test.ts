import { describe, expect, it } from "vitest";
import type { CartItem, CartState } from "../src/session/cart.js";
import {
  kioskFlowReducer,
  type ActiveKioskSession,
  type KioskFlowState,
} from "../src/session/flow.js";

const bottle: CartItem = {
  rawKm: "raw-km",
  kmKey: "010460068200001121serial",
  gtin14: "04600682000011",
  serial: "serial",
  productId: "p1",
  name: "Вода",
  unitPrice: "100.00",
};

const cart = (items: CartItem[] = [bottle]): CartState => ({
  items,
  reason: "buy",
  writeoffReasonId: null,
  notice: null,
});

const active = (canWriteoff: boolean): ActiveKioskSession => ({
  id: 1,
  badgeDigest: "digest",
  employee: {
    id: "e1",
    fullName: "Иванов И.",
    limitMode: "limited",
    dayLimit: 5,
    canWriteoff,
  },
  cart: cart(),
  reason: "buy",
  writeoffReasonId: null,
});

const at = (
  screen: Exclude<KioskFlowState["screen"], "pairing" | "login" | "outcome">,
  canWriteoff = true,
): KioskFlowState => ({ screen, session: active(canWriteoff) });

describe("kioskFlowReducer", () => {
  it("moves pairing to login and a badge admission to an empty cart session", () => {
    const login = kioskFlowReducer({ screen: "pairing" }, { type: "paired" });
    expect(login).toEqual({ screen: "login" });

    const next = kioskFlowReducer(login, { type: "sessionStarted", session: active(true) });
    expect(next).toMatchObject({ screen: "cart", session: { employee: { id: "e1" } } });
  });

  it("skips operation choice for an employee without writeoff permission", () => {
    expect(kioskFlowReducer(at("cart", false), { type: "continue" })).toMatchObject({
      screen: "confirmation",
      session: { reason: "buy", writeoffReasonId: null },
    });
  });

  it("requires a non-empty cart before continuing", () => {
    const state = at("cart");
    if (!("session" in state)) throw new Error("test fixture must be active");
    const empty: KioskFlowState = {
      ...state,
      session: { ...state.session, cart: cart([]) },
    };
    expect(kioskFlowReducer(empty, { type: "continue" })).toBe(empty);
  });

  it("requires a reason before confirming a writeoff", () => {
    const operation = at("operation");
    const writeoff = kioskFlowReducer(operation, {
      type: "chooseOperation",
      reason: "writeoff",
    });
    expect(writeoff).toMatchObject({ screen: "reason", session: { reason: "writeoff" } });
    expect(kioskFlowReducer(writeoff, { type: "continue" })).toBe(writeoff);

    const withReason = kioskFlowReducer(writeoff, {
      type: "chooseWriteoffReason",
      id: "damage",
    });
    expect(kioskFlowReducer(withReason, { type: "continue" })).toMatchObject({
      screen: "confirmation",
      session: { writeoffReasonId: "damage" },
    });
  });

  it("preserves the cart while backing through confirmation, reason, operation and cart", () => {
    const operation = at("operation");
    const reason = kioskFlowReducer(operation, {
      type: "chooseOperation",
      reason: "writeoff",
    });
    const chosen = kioskFlowReducer(reason, { type: "chooseWriteoffReason", id: "damage" });
    const confirmation = kioskFlowReducer(chosen, { type: "continue" });
    const originalCart = confirmation.screen === "confirmation" ? confirmation.session.cart : null;

    const backToReason = kioskFlowReducer(confirmation, { type: "back" });
    const backToOperation = kioskFlowReducer(backToReason, { type: "back" });
    const backToCart = kioskFlowReducer(backToOperation, { type: "back" });

    for (const state of [backToReason, backToOperation, backToCart]) {
      expect("session" in state ? state.session.cart : null).toBe(originalCart);
    }
    expect([backToReason.screen, backToOperation.screen, backToCart.screen]).toEqual([
      "reason",
      "operation",
      "cart",
    ]);
  });

  it.each(["finish", "cancelConfirmed", "logoutConfirmed", "idleReset"] as const)(
    "%s clears the active session and returns to login",
    (type) => {
      const state: KioskFlowState =
        type === "finish"
          ? {
              screen: "outcome",
              session: active(true),
              deviceSeq: 7,
              result: null,
              outcome: { kind: "queued", deviceSeq: 7, bottleCount: 1 },
            }
          : at("confirmation");
      expect(kioskFlowReducer(state, { type })).toEqual({ screen: "login" });
    },
  );

  it("returns every state to pairing when the device is unbound", () => {
    expect(kioskFlowReducer(at("cart"), { type: "unpaired" })).toEqual({ screen: "pairing" });
  });
});
