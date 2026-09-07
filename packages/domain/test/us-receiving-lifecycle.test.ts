import { describe, expect, it } from "vitest";
import {
  assessReceivingTransition,
  getBlockingReceivingConsumerIds,
  isCurrentReceiving,
  type ReceivingConsumerFact,
  type ReceivingLifecycleAction,
  type ReceivingLifecycleState,
} from "../src/index.js";

function state(patch: Partial<ReceivingLifecycleState> = {}): ReceivingLifecycleState {
  return {
    id: "r1",
    rootId: "r1",
    status: "finalized",
    revision: 1,
    supersededByEventId: null,
    currentEventId: "r1",
    pendingDraftId: null,
    lifecycleVersion: 2,
    nextRevision: 2,
    ...patch,
  };
}
const conflict = { ok: false, code: "receiving_lifecycle_conflict", pendingDraftId: null };

describe("Receiving revision lifecycle", () => {
  it.each(["amend", "void"] as const)(
    "keeps the predecessor effective but blocks %s while its amendment is pending",
    (action) => {
      const value = state({ pendingDraftId: "r2", lifecycleVersion: 3, nextRevision: 3 });
      const before = structuredClone(value);
      expect(isCurrentReceiving(value)).toBe(true);
      expect(assessReceivingTransition(value, action)).toEqual({
        ok: false,
        code: "receiving_pending_amendment",
        pendingDraftId: "r2",
      });
      expect(value).toEqual(before);
    },
  );

  it.each([
    [
      state({ status: "draft", currentEventId: null, pendingDraftId: "r1", lifecycleVersion: 1 }),
      "finalize",
    ],
    [
      state({ status: "draft", currentEventId: null, pendingDraftId: "r1", lifecycleVersion: 1 }),
      "void",
    ],
    [state(), "amend"],
    [state(), "void"],
    [
      state({
        id: "r2",
        status: "draft",
        revision: 2,
        pendingDraftId: "r2",
        nextRevision: 3,
        lifecycleVersion: 3,
      }),
      "finalize",
    ],
    [
      state({
        id: "r2",
        status: "draft",
        revision: 2,
        pendingDraftId: "r2",
        nextRevision: 3,
        lifecycleVersion: 3,
      }),
      "void",
    ],
  ] satisfies [ReceivingLifecycleState, ReceivingLifecycleAction][])(
    "allows a valid transition %#",
    (value, action) => {
      expect(assessReceivingTransition(value, action)).toEqual({ ok: true });
    },
  );

  it.each([
    [state(), "finalize"],
    [state({ status: "draft", currentEventId: null, pendingDraftId: "r1" }), "amend"],
    [state({ currentEventId: "other" }), "amend"],
    [state({ supersededByEventId: "r2" }), "void"],
    [state({ status: "draft", currentEventId: null }), "finalize"],
    [state({ status: "draft", currentEventId: null, pendingDraftId: "other" }), "void"],
    [state({ status: "draft", pendingDraftId: "r1" }), "finalize"],
    [
      state({
        id: "r2",
        revision: 2,
        status: "draft",
        currentEventId: null,
        pendingDraftId: "r2",
        nextRevision: 3,
      }),
      "finalize",
    ],
    [state({ id: "r2", revision: 1, currentEventId: "r2" }), "amend"],
    [state({ revision: 2, nextRevision: 3 }), "amend"],
  ] satisfies [ReceivingLifecycleState, ReceivingLifecycleAction][])(
    "rejects inconsistent state or unsupported transition %#",
    (value, action) => {
      expect(assessReceivingTransition(value, action)).toEqual({
        ...conflict,
        pendingDraftId: value.pendingDraftId,
      });
    },
  );

  it.each(["amended", "void"] as const)("never resurrects a terminal %s revision", (status) => {
    const value = state({ status, currentEventId: null });
    expect(isCurrentReceiving(value)).toBe(false);
    for (const action of ["amend", "finalize", "void"] as const)
      expect(assessReceivingTransition(value, action)).toEqual(conflict);
  });

  it("does not use the largest revision or root pointer as the current predicate", () => {
    expect(isCurrentReceiving(state({ nextRevision: 9, pendingDraftId: "r8" }))).toBe(true);
    expect(isCurrentReceiving(state({ status: "draft" }))).toBe(false);
    expect(isCurrentReceiving(state({ supersededByEventId: "r8" }))).toBe(false);
    expect(isCurrentReceiving(state({ currentEventId: null }))).toBe(true);
    expect(assessReceivingTransition(state({ currentEventId: null }), "void")).toEqual(conflict);
  });

  it("accepts abandoned revision gaps without reusing a revision", () => {
    expect(
      assessReceivingTransition(state({ nextRevision: 6, lifecycleVersion: 10 }), "amend"),
    ).toEqual({ ok: true });
    expect(
      assessReceivingTransition(
        state({
          id: "r6",
          status: "draft",
          revision: 6,
          pendingDraftId: "r6",
          nextRevision: 7,
          lifecycleVersion: 11,
        }),
        "finalize",
      ),
    ).toEqual({ ok: true });
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER])(
    "rejects invalid stored counters %s",
    (invalid) => {
      for (const key of ["revision", "nextRevision", "lifecycleVersion"] as const)
        expect(assessReceivingTransition(state({ [key]: invalid }), "amend")).toEqual(conflict);
    },
  );

  it("rejects counter exhaustion before increment, without unnecessarily blocking a void", () => {
    expect(assessReceivingTransition(state({ lifecycleVersion: 2147483647 }), "void")).toEqual(
      conflict,
    );
    expect(assessReceivingTransition(state({ nextRevision: 2147483647 }), "amend")).toEqual(
      conflict,
    );
    expect(assessReceivingTransition(state({ nextRevision: 2147483647 }), "void")).toEqual({
      ok: true,
    });
    expect(assessReceivingTransition(state({ nextRevision: 1 }), "void")).toEqual(conflict);
  });
});

describe("synthetic downstream consumer contract (not persisted dependency coverage)", () => {
  const consumer: ReceivingConsumerFact = {
    eventId: "shipping-b",
    kind: "shipping",
    receiptRootId: "r1",
    lotIds: ["lot-a"],
    status: "finalized",
    supersededByEventId: null,
  };
  const consumers: ReceivingConsumerFact[] = [
    consumer,
    { ...consumer },
    { ...consumer, eventId: "transformation-a", kind: "transformation" },
    { ...consumer, eventId: "different-root", receiptRootId: "r2" },
    { ...consumer, eventId: "different-lot", lotIds: ["lot-b"] },
    { ...consumer, eventId: "draft", status: "draft" },
    { ...consumer, eventId: "void", status: "void" },
    { ...consumer, eventId: "amended", status: "amended", supersededByEventId: "next" },
    { ...consumer, eventId: "superseded", supersededByEventId: "next" },
  ];
  it.each(["material", "void"] as const)(
    "blocks %s only on current consumers of affected lots of the exact receipt root",
    (changeKind) => {
      expect(
        getBlockingReceivingConsumerIds({
          changeKind,
          receiptRootId: "r1",
          affectedLotIds: ["lot-a"],
          consumers,
        }),
      ).toEqual(["shipping-b", "transformation-a"]);
    },
  );
  it("allows documentary changes and material changes of unrelated lots", () => {
    expect(
      getBlockingReceivingConsumerIds({
        changeKind: "documentary",
        receiptRootId: "r1",
        affectedLotIds: ["lot-a"],
        consumers,
      }),
    ).toEqual([]);
    expect(
      getBlockingReceivingConsumerIds({
        changeKind: "material",
        receiptRootId: "r1",
        affectedLotIds: [],
        consumers,
      }),
    ).toEqual([]);
  });
});
