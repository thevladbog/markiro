import { createHash, webcrypto } from "node:crypto";
import {
  createReceivingDraftSchema,
  finalizeReceivingSchema,
  receivingCreateResultSchema,
  receivingSaveResultSchema,
  receivingFinalizeResultSchema,
  receivingOperationReceiptV2Schema,
} from "@markiro/platform-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchesReceivingCreateAcknowledgement as matchesCreate,
  matchesReceivingSaveAcknowledgement as matchesSave,
  matchesReceivingFinalizeAcknowledgement as matchesFinalize,
} from "../src/us/receiving/command-acknowledgement.js";
import { createUsBrowserClient } from "../src/us/client.js";
import {
  createReceipt,
  saveReceipt,
  finalizeReceipt,
  draft,
  liveDraft,
  liveFinalized,
} from "./support/us-receiving-command-fixture.js";
import {
  finalized,
  id,
  operationKey,
  record,
} from "./support/us-receiving-finalization-fixture.js";
import {
  exemptionFinalized,
  exemptionRecord,
  operationKey as exemptKey,
} from "./support/us-receiving-exemption-fixture.js";

const createInput = { operationKey, draft };
const saveInput = { ...createInput, expectedDraftVersion: 7 };
const finalizeInput = {
  operationKey,
  expectedDraftVersion: 7,
  expectedInputDigest: "a".repeat(64),
};
// Independent server-side hashing for non-vector specimens; never browser code.
const serverDigest = (command: string, eventId: string, input: unknown) =>
  createHash("sha256")
    .update(JSON.stringify({ commandVersion: 2, command, eventId, input }))
    .digest("hex");

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("original Receiving command acknowledgement correlation", () => {
  it("accepts the server's create/save/finalize digest vectors without modifying either input or result", async () => {
    receivingCreateResultSchema.parse(createReceipt);
    receivingSaveResultSchema.parse(saveReceipt);
    receivingFinalizeResultSchema.parse(finalizeReceipt);
    const before = JSON.stringify([
      createInput,
      saveInput,
      finalizeInput,
      createReceipt,
      saveReceipt,
      finalizeReceipt,
    ]);
    await expect(matchesCreate(createReceipt, createInput)).resolves.toBe(true);
    await expect(matchesSave(saveReceipt, id, saveInput)).resolves.toBe(true);
    await expect(matchesFinalize(finalizeReceipt, id, finalizeInput)).resolves.toBe(true);
    expect(
      JSON.stringify([
        createInput,
        saveInput,
        finalizeInput,
        createReceipt,
        saveReceipt,
        finalizeReceipt,
      ]),
    ).toBe(before);
  });

  it("canonicalizes request keys, UUIDs and input text exactly as the server before hashing", async () => {
    const input = {
      draft: { ...draft, notes: " Receipt Ä/𐐀 " },
      operationKey: operationKey.toUpperCase(),
    };
    await expect(matchesCreate(createReceipt, input)).resolves.toBe(true);
    await expect(
      matchesSave(saveReceipt, id.toUpperCase(), { expectedDraftVersion: 7, ...input }),
    ).resolves.toBe(true);
    await expect(
      matchesFinalize(finalizeReceipt, id.toUpperCase(), {
        expectedInputDigest: finalizeInput.expectedInputDigest,
        operationKey: operationKey.toUpperCase(),
        expectedDraftVersion: 7,
      }),
    ).resolves.toBe(true);
  });

  it.each([7, 8])(
    "accepts a versioned save's no-op or changed version (%s)",
    async (draftVersion) => {
      await expect(
        matchesSave(
          { ...saveReceipt, record: { ...saveReceipt.record, draftVersion } },
          id,
          saveInput,
        ),
      ).resolves.toBe(true);
    },
  );

  it("rejects schema-valid key, command and digest substitution", async () => {
    for (const value of [
      { ...createReceipt, operationKey: id },
      { ...createReceipt, command: "receiving.save" },
      { ...createReceipt, inputDigest: "0".repeat(64) },
    ]) {
      receivingOperationReceiptV2Schema.parse(value);
      await expect(matchesCreate(value, createInput)).resolves.toBe(false);
    }
    for (const receipt of [saveReceipt, finalizeReceipt]) {
      const check = receipt.command === "receiving.save" ? matchesSave : matchesFinalize;
      const input = receipt.command === "receiving.save" ? saveInput : finalizeInput;
      for (const value of [
        { ...receipt, operationKey: id },
        { ...receipt, inputDigest: "0".repeat(64) },
      ]) {
        receivingOperationReceiptV2Schema.parse(value);
        await expect(check(value, id, input)).resolves.toBe(false);
      }
      await expect(check(receipt, operationKey, input)).resolves.toBe(false);
    }
  });

  it("rejects later current-state versions even when the acknowledgement hash is unchanged", async () => {
    for (const draftVersion of [2, 7]) {
      const value = { ...createReceipt, record: { ...liveDraft, draftVersion } };
      receivingCreateResultSchema.parse(value);
      await expect(matchesCreate(value, createInput)).resolves.toBe(false);
    }
    for (const draftVersion of [6, 9]) {
      const value = { ...saveReceipt, record: { ...saveReceipt.record, draftVersion } };
      receivingSaveResultSchema.parse(value);
      await expect(matchesSave(value, id, saveInput)).resolves.toBe(false);
    }
    const value = { ...finalizeReceipt, record: { ...liveFinalized, draftVersion: 8 } };
    receivingFinalizeResultSchema.parse(value);
    await expect(matchesFinalize(value, id, finalizeInput)).resolves.toBe(false);
  });

  it("rejects a changed draft or finalized confirmation even with the original outer digest", async () => {
    const changedDraft = { kind: "draft", draft: { ...draft, notes: "Another receipt" } };
    await expect(
      matchesCreate(
        { ...createReceipt, record: { ...liveDraft, content: changedDraft } },
        createInput,
      ),
    ).resolves.toBe(false);
    await expect(
      matchesSave(
        { ...saveReceipt, record: { ...saveReceipt.record, content: changedDraft } },
        id,
        saveInput,
      ),
    ).resolves.toBe(false);
    if (liveFinalized.content.kind !== "finalized") throw new Error("Expected frozen fixture");
    const value = {
      ...finalizeReceipt,
      record: {
        ...liveFinalized,
        content: {
          ...liveFinalized.content,
          snapshot: {
            ...liveFinalized.content.snapshot,
            confirmation: {
              ...liveFinalized.content.snapshot.confirmation,
              inputDigest: "b".repeat(64),
            },
          },
        },
      },
    };
    receivingFinalizeResultSchema.parse(value);
    await expect(matchesFinalize(value, id, finalizeInput)).resolves.toBe(false);
  });

  it("rejects a finalized receipt that contains a later pending amendment", async () => {
    const value = {
      ...finalizeReceipt,
      record: {
        ...liveFinalized,
        lifecycle: { ...liveFinalized.lifecycle, pendingDraftId: operationKey },
      },
    };
    receivingFinalizeResultSchema.parse(value);
    await expect(matchesFinalize(value, id, finalizeInput)).resolves.toBe(false);
  });

  it("rejects a later lifecycle token even if its record and command digest otherwise match", async () => {
    const changed = (receipt: typeof createReceipt) => ({
      ...receipt,
      record: {
        ...receipt.record,
        lifecycle: {
          ...receipt.record.lifecycle,
          lifecycleVersion: receipt.record.lifecycle.lifecycleVersion + 1,
        },
      },
    });
    for (const receipt of [createReceipt, saveReceipt, finalizeReceipt])
      receivingOperationReceiptV2Schema.parse(changed(receipt));
    await expect(matchesCreate(changed(createReceipt), createInput)).resolves.toBe(false);
    await expect(matchesSave(changed(saveReceipt), id, saveInput)).resolves.toBe(false);
    await expect(matchesFinalize(changed(finalizeReceipt), id, finalizeInput)).resolves.toBe(false);
  });

  it("does not reinterpret historical frozen v1/v2 content as a newly versioned finalization", async () => {
    for (const legacy of [finalized, exemptionFinalized]) {
      const { snapshot, finalizedAt, finalizedBy, ...header } = legacy;
      const input = {
        operationKey,
        expectedDraftVersion: legacy.draftVersion,
        expectedInputDigest: snapshot.confirmation.inputDigest,
        ...(snapshot.snapshotVersion === 2
          ? { reviewedExemptLines: snapshot.confirmation.reviewedExemptLines }
          : {}),
      };
      const value = {
        ...finalizeReceipt,
        eventId: legacy.id,
        inputDigest: serverDigest(
          "receiving.finalize",
          legacy.id,
          finalizeReceivingSchema.parse(input),
        ),
        record: {
          ...liveFinalized,
          ...header,
          lifecycle: { ...liveFinalized.lifecycle, rootId: legacy.id, currentEventId: legacy.id },
          content: { kind: "finalized", snapshot, finalizedAt, finalizedBy },
        },
      };
      receivingFinalizeResultSchema.parse(value);
      await expect(matchesFinalize(value, legacy.id, input)).resolves.toBe(false);
      await expect(matchesFinalize(legacy, legacy.id, input)).resolves.toBe(true);
    }
  });

  it("keeps omitted/null exemption equivalent only for saved-data comparison, never for a new key's hash", async () => {
    const line = record.draft.items[0];
    if (!line) throw new Error("Expected line fixture");
    const input = createReceivingDraftSchema.parse({
      operationKey,
      draft: { ...draft, items: [line] },
    });
    const value = {
      ...createReceipt,
      inputDigest: serverDigest("receiving.create", id, input),
      record: {
        ...liveDraft,
        content: {
          kind: "draft",
          draft: { ...input.draft, items: [{ ...line, exemptReceipt: null }] },
        },
      },
    };
    receivingCreateResultSchema.parse(value);
    await expect(matchesCreate(value, input)).resolves.toBe(true);
    const changedShape = {
      ...input,
      draft: { ...input.draft, items: [{ ...line, exemptReceipt: null }] },
    };
    await expect(matchesCreate(value, changedShape)).resolves.toBe(false);
    await expect(
      matchesCreate(
        {
          ...value,
          inputDigest: serverDigest(
            "receiving.create",
            id,
            createReceivingDraftSchema.parse(changedShape),
          ),
        },
        changedShape,
      ),
    ).resolves.toBe(true);
  });

  it("keeps an omitted review array distinct from an explicit empty array for versioned receipts", async () => {
    const explicitEmpty = { ...finalizeInput, reviewedExemptLines: [] };
    await expect(matchesFinalize(finalizeReceipt, id, explicitEmpty)).resolves.toBe(false);
    await expect(
      matchesFinalize(
        {
          ...finalizeReceipt,
          inputDigest: serverDigest(
            "receiving.finalize",
            id,
            finalizeReceivingSchema.parse(explicitEmpty),
          ),
        },
        id,
        explicitEmpty,
      ),
    ).resolves.toBe(true);
    await expect(matchesFinalize(finalized, id, explicitEmpty)).resolves.toBe(true);
  });

  it("checks the exact exempt review set in v3 frozen content independently of the command digest", async () => {
    const { snapshot, finalizedAt, finalizedBy, ...header } = exemptionFinalized;
    const input = {
      operationKey: exemptKey,
      expectedDraftVersion: exemptionRecord.draftVersion,
      expectedInputDigest: snapshot.confirmation.inputDigest,
      reviewedExemptLines: [1, 2],
    };
    const value = {
      ...finalizeReceipt,
      eventId: header.id,
      operationKey: exemptKey,
      inputDigest: serverDigest(
        "receiving.finalize",
        header.id,
        finalizeReceivingSchema.parse(input),
      ),
      record: {
        ...liveFinalized,
        ...header,
        lifecycle: { ...liveFinalized.lifecycle, rootId: header.id, currentEventId: header.id },
        content: {
          kind: "finalized",
          finalizedAt,
          finalizedBy,
          snapshot: {
            ...snapshot,
            snapshotVersion: 3,
            items: snapshot.items.map((item) => ({ ...item, lotBinding: { kind: "created" } })),
            confirmation: { ...snapshot.confirmation, ruleVersion: "receiving-readiness-v4" },
          },
        },
      },
    };
    receivingFinalizeResultSchema.parse(value);
    await expect(matchesFinalize(value, header.id, input)).resolves.toBe(true);
    for (const reviewedExemptLines of [[], [1], [1, 2, 3]]) {
      const badInput = { ...input, reviewedExemptLines };
      await expect(
        matchesFinalize(
          {
            ...value,
            inputDigest: serverDigest(
              "receiving.finalize",
              header.id,
              finalizeReceivingSchema.parse(badInput),
            ),
          },
          header.id,
          badInput,
        ),
      ).resolves.toBe(false);
    }
  });

  it("never accepts raw live reads, unknown versions or extra response fields as acknowledgements", async () => {
    for (const value of [
      liveDraft,
      { ...createReceipt, receiptVersion: 3 },
      { ...createReceipt, internal: "private" },
    ])
      await expect(matchesCreate(value, createInput)).resolves.toBe(false);
    await expect(matchesSave(liveDraft, id, saveInput)).resolves.toBe(false);
    await expect(matchesFinalize(liveFinalized, id, finalizeInput)).resolves.toBe(false);
  });

  it("does not downgrade partial/explicit amendment commands into original commands", async () => {
    await expect(matchesCreate(createReceipt, { ...createInput, commandVersion: 2 })).resolves.toBe(
      false,
    );
    await expect(matchesSave(saveReceipt, id, { ...saveInput, commandVersion: 2 })).resolves.toBe(
      false,
    );
    await expect(
      matchesFinalize(finalizeReceipt, id, {
        ...finalizeInput,
        commandVersion: 2,
        expectedLifecycleVersion: 1,
        previousRevisionId: null,
        reviewedExemptLines: [],
      }),
    ).resolves.toBe(false);
  });

  it("fails closed if native hashing is unavailable without retaining an error or attempting transport", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(matchesCreate(createReceipt, createInput)).resolves.toBe(false);
    await expect(matchesSave(saveReceipt, id, saveInput)).resolves.toBe(false);
    await expect(matchesFinalize(finalizeReceipt, id, finalizeInput)).resolves.toBe(false);
    await expect(matchesFinalize(finalized, id, finalizeInput)).resolves.toBe(true);
  });

  it("accepts the correlated receipt without treating it as a live read or retrying implicitly", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(createReceipt));
    await expect(createUsBrowserClient(send).createReceivingDraft(createInput)).resolves.toEqual(
      createReceipt,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
