import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import {
  at,
  draft,
  header,
  eventId,
  successorId,
  otherId,
  lotId,
  lifecycle,
  liveFinalized,
  finalized,
  snapshotV2,
  snapshotV3,
  review,
} from "./support/us-receiving-lifecycle-fixture.js";

const liveDraft = {
  ...header,
  recordVersion: 2,
  status: "draft",
  lifecycle: {
    ...lifecycle,
    lifecycleVersion: 1,
    currentEventId: null,
    pendingDraftId: eventId,
  },
  content: { kind: "draft", draft },
};
const amendment = {
  ...liveDraft,
  id: successorId,
  revision: 2,
  lifecycle: {
    ...lifecycle,
    lifecycleVersion: 3,
    previousRevisionId: eventId,
    amendmentReason: "  Corrected count  ",
    pendingDraftId: successorId,
  },
};
const superseded = {
  ...liveFinalized,
  status: "amended",
  lifecycle: {
    ...lifecycle,
    lifecycleVersion: 4,
    currentEventId: successorId,
    supersededByEventId: successorId,
    supersededAt: "2026-09-07T11:00:00.000Z",
    supersededBy: "new-qa",
  },
};
const voided = {
  ...liveFinalized,
  status: "void",
  lifecycle: {
    ...lifecycle,
    lifecycleVersion: 3,
    currentEventId: null,
    voidReason: "  Duplicate receipt  ",
    voidedAt: "2026-09-07T11:00:00.000Z",
    voidedBy: "other-qa",
  },
};
const voidDraft = { ...liveDraft, status: "void", lifecycle: voided.lifecycle };

describe("live Receiving lifecycle separate from historical content", () => {
  it.each([
    { name: "original draft", value: liveDraft },
    { name: "amendment draft", value: amendment },
    { name: "current finalized", value: liveFinalized },
    { name: "amended", value: superseded },
    { name: "voided finalized", value: voided },
    { name: "voided draft", value: voidDraft },
    {
      name: "cancelled amendment with another pending draft",
      value: {
        ...amendment,
        status: "void",
        lifecycle: {
          ...voided.lifecycle,
          currentEventId: eventId,
          previousRevisionId: eventId,
          amendmentReason: "  Corrected count  ",
          pendingDraftId: otherId,
        },
      },
    },
    {
      name: "current while amendment pending",
      value: {
        ...liveFinalized,
        lifecycle: { ...lifecycle, lifecycleVersion: 3, pendingDraftId: successorId },
      },
    },
  ])("reads $name without rewriting content", ({ value }) => {
    expect(contracts.receivingLiveRecordSchema.parse(value)).toEqual(value);
  });

  it.each([
    {
      name: "unknown lifecycle key",
      value: { ...liveFinalized, lifecycle: { ...lifecycle, actorId: "forged" } },
    },
    {
      name: "missing null pointer",
      value: { ...liveFinalized, lifecycle: { ...lifecycle, pendingDraftId: undefined } },
    },
    { name: "finalized draft content", value: { ...liveFinalized, content: liveDraft.content } },
    { name: "draft frozen content", value: { ...liveDraft, content: liveFinalized.content } },
    { name: "amended without successor", value: { ...liveFinalized, status: "amended" } },
    {
      name: "void without reason",
      value: { ...voided, lifecycle: { ...voided.lifecycle, voidReason: null } },
    },
    {
      name: "void without actor",
      value: { ...voided, lifecycle: { ...voided.lifecycle, voidedBy: null } },
    },
    {
      name: "void as current",
      value: { ...voided, lifecycle: { ...voided.lifecycle, currentEventId: eventId } },
    },
    {
      name: "draft without pending pointer",
      value: { ...liveDraft, lifecycle: { ...liveDraft.lifecycle, pendingDraftId: null } },
    },
    { name: "original draft with current pointer", value: { ...liveDraft, lifecycle } },
    {
      name: "amendment without predecessor",
      value: { ...amendment, lifecycle: { ...amendment.lifecycle, previousRevisionId: null } },
    },
    {
      name: "amendment without reason",
      value: { ...amendment, lifecycle: { ...amendment.lifecycle, amendmentReason: null } },
    },
    {
      name: "amendment without current predecessor",
      value: { ...amendment, lifecycle: { ...amendment.lifecycle, currentEventId: null } },
    },
    {
      name: "amendment pointing to itself",
      value: {
        ...amendment,
        lifecycle: { ...amendment.lifecycle, previousRevisionId: successorId },
      },
    },
    { name: "amendment using root identity", value: { ...amendment, id: eventId } },
    {
      name: "original with predecessor",
      value: { ...liveFinalized, lifecycle: { ...lifecycle, previousRevisionId: otherId } },
    },
    {
      name: "finalized without current pointer",
      value: { ...liveFinalized, lifecycle: { ...lifecycle, currentEventId: null } },
    },
    {
      name: "finalized with stale supersession actor",
      value: { ...liveFinalized, lifecycle: { ...lifecycle, supersededBy: "qa" } },
    },
    { name: "void rewrites original finalizer", value: { ...voided, updatedBy: "other-qa" } },
    {
      name: "void rewrites content update timestamp",
      value: { ...voided, updatedAt: "2026-09-07T11:00:00.000Z" },
    },
    {
      name: "invalid counter",
      value: { ...liveFinalized, lifecycle: { ...lifecycle, lifecycleVersion: 2147483648 } },
    },
  ])("rejects inconsistent $name", ({ value }) => {
    expect(contracts.receivingLiveRecordSchema.safeParse(value).success).toBe(false);
  });

  it("preserves v1/v2 content under later lifecycle metadata", () => {
    for (const snapshot of [finalized.snapshot, snapshotV2]) {
      const value = { ...superseded, content: { ...superseded.content, snapshot } };
      expect(contracts.receivingLiveRecordSchema.parse(value)).toEqual(value);
    }
    expect(
      contracts.receivingLiveRecordSchema.safeParse({
        ...amendment,
        status: "finalized",
        lifecycle: { ...amendment.lifecycle, pendingDraftId: null, currentEventId: successorId },
        content: { ...liveFinalized.content, snapshot: snapshotV2 },
      }).success,
    ).toBe(false);
  });

  it("does not reopen a voided effective receipt with another current or pending revision", () => {
    for (const patch of [{ currentEventId: successorId }, { pendingDraftId: successorId }])
      expect(
        contracts.receivingLiveRecordSchema.safeParse({
          ...voided,
          lifecycle: { ...voided.lifecycle, ...patch },
        }).success,
      ).toBe(false);
  });

  it("binds frozen retained lines to the immediate predecessor and fresh finalizer", () => {
    const snapshot = {
      ...snapshotV3,
      items: [
        {
          ...at(snapshotV3.items, 0),
          lotBinding: { kind: "retained", previousEventId: eventId, previousLineNo: 1 },
          receiptBasis: { kind: "exempt_existing_tlc", ...review },
        },
      ],
      confirmation: { ...snapshotV3.confirmation, reviewedExemptLines: [1] },
    };
    const value = {
      ...amendment,
      status: "finalized",
      lifecycle: { ...amendment.lifecycle, currentEventId: successorId, pendingDraftId: null },
      content: { ...liveFinalized.content, snapshot },
    };
    expect(contracts.receivingLiveRecordSchema.parse(value)).toEqual(value);
    expect(
      contracts.receivingLiveRecordSchema.safeParse({ ...liveFinalized, content: value.content })
        .success,
    ).toBe(false);
    for (const patch of [
      { lotBinding: { kind: "retained", previousEventId: otherId, previousLineNo: 1 } },
      { receiptBasis: { kind: "exempt_existing_tlc", ...review, reviewedBy: "old-qa" } },
      {
        receiptBasis: {
          kind: "exempt_existing_tlc",
          ...review,
          reviewedAt: "2026-09-06T10:00:00.000Z",
        },
      },
    ])
      expect(
        contracts.receivingLiveRecordSchema.safeParse({
          ...value,
          content: {
            ...value.content,
            snapshot: { ...snapshot, items: [{ ...at(snapshot.items, 0), ...patch }] },
          },
        }).success,
      ).toBe(false);
  });

  it("keeps saved amendment text and bindings lossless, without accepting bindings in original content", () => {
    const item = {
      productId: null,
      lotId: null,
      lotLinkMode: "create_on_finalize",
      tlc: null,
      source: null,
      exemptSupplier: false,
      exemptReason: null,
      supplierLotReference: null,
      quantity: null,
      unitOfMeasure: null,
      notes: "  Historical note  ",
      previousLineNo: null,
    };
    const content = { kind: "draft", draft: { ...draft, items: [item] } };
    expect(contracts.receivingLiveRecordSchema.parse({ ...amendment, content })).toEqual({
      ...amendment,
      content,
    });
    expect(contracts.receivingLiveRecordSchema.safeParse({ ...liveDraft, content }).success).toBe(
      false,
    );
    const { previousLineNo, ...ordinary } = item;
    void previousLineNo;
    expect(
      contracts.receivingLiveRecordSchema.safeParse({
        ...amendment,
        content: { ...content, draft: { ...draft, items: [ordinary] } },
      }).success,
    ).toBe(false);
  });
});

describe("Receiving command acknowledgements", () => {
  it("accepts exact historical legacy receipts independently of a later live void", () => {
    const oldDraft = { ...header, status: "draft", draft };
    for (const value of [oldDraft, finalized, { ...finalized, snapshot: snapshotV2 }])
      expect(contracts.receivingCommandResultSchema.parse(value)).toEqual(value);
    expect(contracts.receivingLiveRecordSchema.parse(voided)).toEqual(voided);
  });
  it.each([
    { command: "receiving.create", record: liveDraft },
    { command: "receiving.save", record: amendment },
    { command: "receiving.amend", record: amendment },
    { command: "receiving.finalize", record: liveFinalized },
    { command: "receiving.void", record: voided },
  ])(
    "reads an immutable $command acknowledgement, not an effective-state promise",
    ({ command, record }) => {
      const receipt = {
        receiptVersion: 2,
        command,
        operationKey: otherId,
        inputDigest: "a".repeat(64),
        eventId: record.id,
        record,
      };
      expect(contracts.receivingOperationReceiptV2Schema.parse(receipt)).toEqual(receipt);
      expect(contracts.receivingCommandResultSchema.parse(receipt)).toEqual(receipt);
      expect(
        contracts.receivingOperationReceiptV2Schema.safeParse({ ...receipt, eventId: lotId })
          .success,
      ).toBe(false);
      expect(
        contracts.receivingOperationReceiptV2Schema.safeParse({ ...receipt, actorId: "forged" })
          .success,
      ).toBe(false);
      expect(
        contracts.receivingOperationReceiptV2Schema.safeParse({
          ...receipt,
          command: command === "receiving.void" ? "receiving.amend" : "receiving.void",
        }).success,
      ).toBe(false);
    },
  );
});

describe("current Receiving basis and bounded revision history", () => {
  it("uses bounded canonical history/basis pagination without accepting registry filters", () => {
    for (const schema of [
      contracts.receivingRevisionListQuerySchema,
      contracts.receivingBasisQuerySchema,
    ]) {
      expect(schema.parse({})).toEqual({ limit: 50, offset: 0 });
      expect(schema.parse({ limit: "100", offset: "100000" })).toEqual({
        limit: 100,
        offset: 100000,
      });
      for (const query of [
        { limit: "01" },
        { offset: "-1" },
        { offset: 100001 },
        { limit: 101 },
        { search: "REC" },
        { history: "all" },
        { tenantId: "forged" },
      ])
        expect(schema.safeParse(query).success).toBe(false);
    }
  });
  const entry = {
    rootId: eventId,
    eventId,
    eventNumber: "REC-26-0001",
    revision: 1,
    lineNos: [1, 3],
  };
  const basis = {
    lotId,
    basisVersion: 1,
    state: "present",
    supportCount: 1,
    items: [entry],
    limit: 50,
    offset: 0,
    hasMore: false,
  };
  const { content, ...summaryHeader } = liveFinalized;
  void content;
  const summary = {
    ...summaryHeader,
    dateReceived: "2026-09-07",
    locationId: null,
    previousSourceLocationId: null,
    lineCount: 1,
    documentCount: 1,
  };
  it("does not infer missing basis from an empty later page", () => {
    expect(contracts.receivingBasisSchema.parse(basis)).toEqual(basis);
    const later = { ...basis, offset: 50, items: [] };
    expect(contracts.receivingBasisSchema.parse(later)).toEqual(later);
    const missing = { ...basis, state: "missing", supportCount: 0, items: [] };
    expect(contracts.receivingBasisSchema.parse(missing)).toEqual(missing);
    const more = { ...basis, supportCount: 2, limit: 1, hasMore: true };
    expect(contracts.receivingBasisSchema.parse(more)).toEqual(more);
  });
  it.each([
    { state: "missing" },
    { supportCount: 0 },
    { hasMore: true },
    { items: [] },
    { basisVersion: 0 },
    { offset: 100001 },
    { limit: 101 },
    { items: [{ ...entry, lineNos: [1, 1] }] },
    { items: [{ ...entry, lineNos: [3, 1] }] },
    { items: [{ ...entry, lineNos: [] }] },
    { items: [{ ...entry, tenantId: "forged" }] },
    { items: [entry, entry], supportCount: 2 },
  ])("rejects misleading or inconsistent basis %#", (patch) => {
    expect(contracts.receivingBasisSchema.safeParse({ ...basis, ...patch }).success).toBe(false);
  });
  it("enforces one root/version and ascending unique revisions within a bounded history page", () => {
    const value = { items: [summary], lifecycleVersion: 2, limit: 50, offset: 0 };
    expect(contracts.receivingRevisionListSchema.parse(value)).toEqual(value);
    for (const patch of [
      { lifecycleVersion: 3 },
      { items: [summary, summary] },
      { limit: 0 },
      { offset: 100001 },
      { items: [{ ...summary, status: "void" }] },
      { items: [{ ...summary, lineCount: 101 }] },
    ])
      expect(contracts.receivingRevisionListSchema.safeParse({ ...value, ...patch }).success).toBe(
        false,
      );
  });
});
