import { describe, expect, it } from "vitest";

import {
  HUB_PAGE_SIZE,
  hubLayout,
  hubPage,
  queueBadge,
  shiftProgress,
} from "../src/floor/shifts/hub-layout.js";

describe("the hub's card layout by the number of shifts", () => {
  it("0: the empty state, no pager", () => {
    expect(hubLayout(0)).toEqual({ kind: "empty", columns: 0, photo: 0, pageCount: 1 });
  });
  it("1: one card on the full width, the photo 520 px", () => {
    expect(hubLayout(1)).toEqual({ kind: "cards", columns: 1, photo: 520, pageCount: 1 });
  });
  it("2: two columns, the photo 260 px", () => {
    expect(hubLayout(2)).toEqual({ kind: "cards", columns: 2, photo: 260, pageCount: 1 });
  });
  it("3 and more: pages of two (the code's page size), the pager in the title row", () => {
    expect(HUB_PAGE_SIZE).toBe(2);
    expect(hubLayout(3)).toEqual({ kind: "cards", columns: 2, photo: 260, pageCount: 2 });
    expect(hubLayout(4).pageCount).toBe(2);
    expect(hubLayout(5).pageCount).toBe(3);
  });
  it("a last page holding one card keeps the two-column grid (no card grows to a page of its own)", () => {
    expect(hubLayout(3).columns).toBe(2);
    expect(hubPage(3, 2)).toEqual({ page: 2, from: 2, to: 3 });
  });
  it("clamps the requested page to the list that got shorter", () => {
    expect(hubPage(3, 9)).toEqual({ page: 2, from: 2, to: 3 });
    expect(hubPage(3, 0)).toEqual({ page: 1, from: 0, to: 2 });
    expect(hubPage(0, 4)).toEqual({ page: 1, from: 0, to: 0 });
  });
});

describe("the progress «Принято N из M» of a shift card", () => {
  it("is there when this station holds the shift and the plan is known", () => {
    expect(shiftProgress({ plannedQty: 1200, accepted: 840, entered: true })).toEqual({
      accepted: 840,
      planned: 1200,
      ratio: 0.7,
    });
  });
  it("is hidden without a plan (null or zero), the way the card says «План не указан»", () => {
    expect(shiftProgress({ plannedQty: null, accepted: 5, entered: true })).toBeNull();
    expect(shiftProgress({ plannedQty: 0, accepted: 5, entered: true })).toBeNull();
  });
  it("is hidden when the count is unavailable: a shift this station did not enter, a failed read", () => {
    expect(shiftProgress({ plannedQty: 1200, accepted: 0, entered: false })).toBeNull();
    expect(shiftProgress({ plannedQty: 1200, accepted: null, entered: true })).toBeNull();
  });
  it("keeps the count as it is past the plan, with the bar full", () => {
    expect(shiftProgress({ plannedQty: 100, accepted: 130, entered: true })).toEqual({
      accepted: 130,
      planned: 100,
      ratio: 1,
    });
  });
  it("shows a started shift's zero", () => {
    expect(shiftProgress({ plannedQty: 100, accepted: 0, entered: true })).toMatchObject({
      accepted: 0,
      ratio: 0,
    });
  });
});

describe("the badge on the hub's «Очередь отправки»", () => {
  it("is a quiet zero while nothing waits", () => {
    expect(queueBadge({ unsent: 0, rejected: 0 })).toEqual({ kind: "none", tone: "neutral", n: 0 });
  });
  it("warns «N ждут» while records wait for the host", () => {
    expect(queueBadge({ unsent: 3, rejected: 0 })).toEqual({
      kind: "waiting",
      tone: "warn",
      n: 3,
    });
  });
  it("says a refusal first: the host's «Отклонено» is the one the operator cannot miss", () => {
    expect(queueBadge({ unsent: 3, rejected: 2 })).toEqual({
      kind: "rejected",
      tone: "error",
      n: 2,
    });
  });
  it("is nothing before the outbox was read", () => {
    expect(queueBadge(null)).toBeNull();
  });
});
