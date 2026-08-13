import { describe, expect, it } from "vitest";
import type { CartItem, CartState } from "../src/session/cart.js";
import {
  createConfirmedOrderBody,
  kioskFlowReducer,
  type ActiveKioskSession,
  type KioskFlowState,
} from "../src/session/flow.js";

const bottle: CartItem = {
  kind: "km",
  rawKm: "raw-km",
  kmKey: "010460068200001121serial",
  gtin14: "04600682000011",
  serial: "serial",
  productId: "p1",
  name: "Вода",
  unitPrice: "100.00",
  bottleCount: 1,
};

const cart = (lines: CartItem[] = [bottle]): CartState => ({
  lines,
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
      session: { cart: { reason: "buy", writeoffReasonId: null } },
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
    expect(writeoff).toMatchObject({
      screen: "reason",
      session: { cart: { reason: "writeoff" } },
    });
    expect(kioskFlowReducer(writeoff, { type: "continue" })).toBe(writeoff);

    const withReason = kioskFlowReducer(writeoff, {
      type: "chooseWriteoffReason",
      id: "damage",
    });
    expect(kioskFlowReducer(withReason, { type: "continue" })).toMatchObject({
      screen: "confirmation",
      session: { cart: { writeoffReasonId: "damage" } },
    });
  });

  it("atomically validates and canonicalizes a legacy submit draft", () => {
    const staleWriteoff = { ...cart(), reason: "writeoff" as const, writeoffReasonId: null };
    const noWriteoff = kioskFlowReducer(at("cart", false), {
      type: "legacySubmit",
      cart: staleWriteoff,
    });
    expect(noWriteoff).toMatchObject({
      screen: "confirmation",
      session: { cart: { reason: "buy", writeoffReasonId: null } },
    });
    if (noWriteoff.screen !== "confirmation") throw new Error("expected confirmation");
    expect(createConfirmedOrderBody(noWriteoff, 7, "2026-08-13T12:00:00Z")).toEqual({
      deviceSeq: 7,
      badgeDigest: "digest",
      reason: "buy",
      writeoffReasonId: null,
      items: [{ rawKm: "raw-km" }],
      createdAt: "2026-08-13T12:00:00Z",
    });

    const allowed = at("cart", true);
    if (!("session" in allowed)) throw new Error("test fixture must be active");
    const writeoff = kioskFlowReducer(allowed, {
      type: "legacySubmit",
      cart: staleWriteoff,
    });
    expect(writeoff).toMatchObject({ screen: "cart" });
    expect("session" in writeoff ? writeoff.session.cart : null).toBe(allowed.session.cart);
  });

  it("emits loose items and opaque boxes with the bottle estimate but no content keys", () => {
    const state = at("confirmation");
    if (state.screen !== "confirmation") throw new Error("expected confirmation fixture");
    state.session.cart = {
      ...state.session.cart,
      lines: [
        bottle,
        {
          kind: "box",
          boxId: "11111111-1111-4111-8111-111111111111",
          sscc: "346006820000000021",
          productId: "p1",
          name: "Вода",
          bottleCount: 12,
          unitPrice: "100.00",
          contentKeys: ["secret-member"],
          registryVersion: "4",
        },
      ],
    };
    const body = createConfirmedOrderBody(state, 8, "2026-08-13T12:00:00Z");
    expect(body).toEqual({
      deviceSeq: 8,
      badgeDigest: "digest",
      reason: "buy",
      writeoffReasonId: null,
      items: [{ rawKm: "raw-km" }],
      boxes: [{ sscc: "346006820000000021" }],
      createdAt: "2026-08-13T12:00:00Z",
    });
    expect(JSON.stringify(body)).not.toContain("secret-member");
  });

  it("returns a failed confirmation to cart and revalidates the edited retry", () => {
    const confirmation = kioskFlowReducer(at("cart", true), {
      type: "legacySubmit",
      cart: cart(),
    });
    expect(confirmation.screen).toBe("confirmation");
    const retry = kioskFlowReducer(confirmation, { type: "submitFailed" });
    expect(retry).toMatchObject({ screen: "cart", session: { cart: cart() } });

    const empty = kioskFlowReducer(retry, { type: "legacySubmit", cart: cart([]) });
    expect(empty).toBe(retry);
    const missingReason = kioskFlowReducer(retry, {
      type: "legacySubmit",
      cart: { ...cart(), reason: "writeoff", writeoffReasonId: null },
    });
    expect(missingReason).toBe(retry);
  });

  it("does not edit the confirmed draft from non-cart screens", () => {
    const confirmation = kioskFlowReducer(at("cart", true), {
      type: "legacySubmit",
      cart: cart(),
    });
    const edit = kioskFlowReducer(confirmation, { type: "cartChanged", cart: cart([]) });
    expect(edit).toBe(confirmation);
  });

  it("keeps operation and writeoff reason only in the canonical cart", () => {
    const writeoff = kioskFlowReducer(at("operation"), {
      type: "chooseOperation",
      reason: "writeoff",
    });
    const chosen = kioskFlowReducer(writeoff, { type: "chooseWriteoffReason", id: "damage" });
    expect(chosen).toMatchObject({
      session: { cart: { reason: "writeoff", writeoffReasonId: "damage" } },
    });
  });

  it("source-bounds reset actions", () => {
    expect(kioskFlowReducer({ screen: "login" }, { type: "finish" })).toEqual({
      screen: "login",
    });
    expect(kioskFlowReducer({ screen: "pairing" }, { type: "idleReset" })).toEqual({
      screen: "pairing",
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
