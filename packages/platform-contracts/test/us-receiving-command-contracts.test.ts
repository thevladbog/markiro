import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import {
  draft,
  header,
  eventId,
  successorId,
  lifecycle,
  liveFinalized,
  finalized,
  snapshotV2,
} from "./support/us-receiving-lifecycle-fixture.js";

const legacyDraft = { ...header, status: "draft", draft };
const liveDraft = {
  ...header,
  recordVersion: 2,
  status: "draft",
  lifecycle: { ...lifecycle, lifecycleVersion: 1, currentEventId: null, pendingDraftId: eventId },
  content: { kind: "draft", draft },
};
const receipt = {
  receiptVersion: 2,
  command: "receiving.create",
  operationKey: successorId,
  inputDigest: "a".repeat(64),
  eventId,
  record: liveDraft,
};

describe("Receiving command-specific historical results", () => {
  it.each([
    {
      name: "create",
      schema: () => contracts.receivingCreateResultSchema,
      command: "receiving.create",
    },
    { name: "save", schema: () => contracts.receivingSaveResultSchema, command: "receiving.save" },
  ])("accepts exact old and versioned $name results", ({ schema, command }) => {
    expect(schema().parse(legacyDraft)).toEqual(legacyDraft);
    const value = { ...receipt, command };
    expect(schema().parse(value)).toEqual(value);
    expect(schema().safeParse(finalized).success).toBe(false);
  });

  it("accepts both old frozen versions and the new finalize receipt losslessly", () => {
    for (const value of [
      finalized,
      { ...finalized, snapshot: snapshotV2 },
      { ...receipt, command: "receiving.finalize", record: liveFinalized },
    ])
      expect(contracts.receivingFinalizeResultSchema.parse(value)).toEqual(value);
    expect(contracts.receivingFinalizeResultSchema.safeParse(legacyDraft).success).toBe(false);
  });

  it("does not accept another command's valid receipt or an unwrapped live record", () => {
    const results = [
      { schema: contracts.receivingCreateResultSchema, value: receipt },
      {
        schema: contracts.receivingSaveResultSchema,
        value: { ...receipt, command: "receiving.save" },
      },
      {
        schema: contracts.receivingFinalizeResultSchema,
        value: { ...receipt, command: "receiving.finalize", record: liveFinalized },
      },
    ];
    for (const [index, result] of results.entries()) {
      expect(result.schema.safeParse(result.value.record).success).toBe(false);
      for (const [otherIndex, other] of results.entries()) {
        if (index !== otherIndex) expect(result.schema.safeParse(other.value).success).toBe(false);
      }
      expect(result.schema.safeParse({ ...result.value, eventId: successorId }).success).toBe(
        false,
      );
    }
  });

  it("preserves amendment saves without treating them as original creation", () => {
    const value = {
      ...receipt,
      command: "receiving.save",
      eventId: successorId,
      record: {
        ...liveDraft,
        id: successorId,
        revision: 2,
        lifecycle: {
          ...lifecycle,
          lifecycleVersion: 3,
          previousRevisionId: eventId,
          amendmentReason: "Correct count",
          pendingDraftId: successorId,
        },
      },
    };
    expect(contracts.receivingSaveResultSchema.parse(value)).toEqual(value);
    expect(
      contracts.receivingCreateResultSchema.safeParse({ ...value, command: "receiving.create" })
        .success,
    ).toBe(false);
  });
});

describe("Receiving original/revision input bridge contracts", () => {
  const originalSave = {
    operationKey: successorId.toLowerCase(),
    expectedDraftVersion: 1,
    draft: { ...draft, locationId: null, notes: null },
  };
  const originalFinalize = {
    operationKey: successorId.toLowerCase(),
    expectedDraftVersion: 1,
    expectedInputDigest: "a".repeat(64),
  };
  const revision = { commandVersion: 2, expectedLifecycleVersion: 3 };

  it("keeps original input normalization and optional exemption confirmation unchanged", () => {
    expect(
      contracts.saveReceivingCommandSchema.parse({ ...originalSave, operationKey: successorId }),
    ).toEqual(originalSave);
    expect(
      contracts.finalizeReceivingCommandSchema.parse({
        ...originalFinalize,
        operationKey: successorId,
      }),
    ).toEqual(originalFinalize);
  });

  it("requires complete explicit revision input and rejects hybrid downgrade payloads", () => {
    const save = { ...originalSave, ...revision };
    const finalize = {
      ...originalFinalize,
      ...revision,
      previousRevisionId: eventId.toLowerCase(),
      reviewedExemptLines: [],
    };
    expect(contracts.saveReceivingCommandSchema.parse(save)).toEqual(save);
    expect(contracts.finalizeReceivingCommandSchema.parse(finalize)).toEqual(finalize);
    for (const patch of [
      { commandVersion: undefined },
      { expectedLifecycleVersion: undefined },
      { commandVersion: 1 },
      { actorId: "forged" },
    ]) {
      expect(contracts.saveReceivingCommandSchema.safeParse({ ...save, ...patch }).success).toBe(
        false,
      );
      expect(
        contracts.finalizeReceivingCommandSchema.safeParse({ ...finalize, ...patch }).success,
      ).toBe(false);
    }
    for (const patch of [{ previousRevisionId: undefined }, { reviewedExemptLines: undefined }])
      expect(
        contracts.finalizeReceivingCommandSchema.safeParse({ ...finalize, ...patch }).success,
      ).toBe(false);
    expect(
      contracts.finalizeReceivingCommandSchema.safeParse({
        ...originalFinalize,
        previousRevisionId: eventId,
      }).success,
    ).toBe(false);
  });
});
