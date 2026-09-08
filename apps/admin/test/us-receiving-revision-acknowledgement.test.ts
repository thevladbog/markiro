import { createHash, webcrypto } from "node:crypto";
import {
  amendReceivingSchema,
  finalizeReceivingRevisionSchema,
  receivingLiveRecordSchema,
  receivingOperationReceiptV2Schema,
  saveReceivingAmendmentSchema,
  voidReceivingSchema,
  type ReceivingLiveRecord,
  type ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchesReceivingSaveAcknowledgement as matchesSave,
  matchesReceivingFinalizeAcknowledgement as matchesFinalize,
  matchesReceivingAmendAcknowledgement as matchesAmend,
  matchesReceivingVoidAcknowledgement as matchesVoid,
} from "../src/us/receiving/command-acknowledgement.js";
import {
  amendment,
  amendmentId,
  amendmentFinalized,
  saveInput,
  finalizeInput,
  amendInput,
  predecessor,
  reason,
} from "./support/us-receiving-revision-command-fixture.js";
import {
  id,
  lotId,
  operationKey,
  record,
  finalized,
} from "./support/us-receiving-finalization-fixture.js";
import { liveDraft, liveFinalized } from "./support/us-receiving-command-fixture.js";
import { exemptionFinalized, exemptionRecord } from "./support/us-receiving-exemption-fixture.js";
import { createUsBrowserClient } from "../src/us/client.js";
import { liveFixture } from "./support/us-receiving-live-fixture.js";

// Independent Node/server hashing, not the native Web Crypto implementation under test.
function receipt(
  command: ReceivingOperationReceiptV2["command"],
  eventId: string,
  input: unknown,
  record: ReceivingLiveRecord,
) {
  return receivingOperationReceiptV2Schema.parse({
    receiptVersion: 2,
    command,
    operationKey,
    inputDigest: createHash("sha256")
      .update(JSON.stringify({ commandVersion: 2, command, eventId, input }))
      .digest("hex"),
    eventId: record.id,
    record,
  });
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("explicit Receiving revision acknowledgement correlation", () => {
  it("accepts a no-op amendment save against the captured draft and lifecycle", async () => {
    const value = receipt(
      "receiving.save",
      amendmentId,
      saveReceivingAmendmentSchema.parse(saveInput),
      amendment,
    );
    await expect(matchesSave(value, amendmentId, saveInput, amendment)).resolves.toBe(true);
  });

  it("accepts a revision finalization with the captured predecessor and retained line bindings", async () => {
    const value = receipt(
      "receiving.finalize",
      amendmentId,
      finalizeReceivingRevisionSchema.parse(finalizeInput),
      amendmentFinalized,
    );
    await expect(matchesFinalize(value, amendmentId, finalizeInput, amendment)).resolves.toBe(true);
  });

  it("accepts amendment creation with a predecessor-target digest and a distinct result ID", async () => {
    const value = receipt("receiving.amend", id, amendReceivingSchema.parse(amendInput), amendment);
    expect(value.inputDigest).toBe(
      "a7e6ac26993e0cb6a60633b87a5b50fcd6ce4462ffb326392f0d98e02faa4735",
    );
    await expect(matchesAmend(value, id, amendInput, predecessor)).resolves.toBe(true);
    await expect(
      matchesAmend(
        value,
        id.toUpperCase(),
        {
          reason: ` ${reason} `,
          expectedLifecycleVersion: 4,
          operationKey: operationKey.toUpperCase(),
          commandVersion: 2,
        },
        predecessor,
      ),
    ).resolves.toBe(true);
    const wrongTarget = receipt(
      "receiving.amend",
      amendmentId,
      amendReceivingSchema.parse(amendInput),
      amendment,
    );
    await expect(matchesAmend(wrongTarget, id, amendInput, predecessor)).resolves.toBe(false);
  });

  it.each([liveDraft, predecessor, amendment, amendmentFinalized])(
    "accepts void of captured $status revision $revision without changing saved content",
    async (before) => {
      const input = voidReceivingSchema.parse({
        commandVersion: 2,
        operationKey,
        expectedLifecycleVersion: before.lifecycle.lifecycleVersion,
        expectedDraftVersion: before.status === "draft" ? before.draftVersion : null,
        reason,
      });
      const after = voided(before);
      const value = receipt("receiving.void", before.id, input, after);
      const original = JSON.stringify([value, input, before]);
      await expect(matchesVoid(value, before.id, input, before)).resolves.toBe(true);
      expect(JSON.stringify([value, input, before])).toBe(original);
    },
  );
});

function voided(before: ReceivingLiveRecord) {
  return receivingLiveRecordSchema.parse({
    ...before,
    status: "void",
    lifecycle: {
      ...before.lifecycle,
      lifecycleVersion: before.lifecycle.lifecycleVersion + 1,
      currentEventId: before.status === "draft" ? before.lifecycle.currentEventId : null,
      pendingDraftId: null,
      voidedAt: "2026-09-08T10:00:00.000Z",
      voidedBy: "qa-user",
      voidReason: reason,
    },
  });
}

describe("revision save and finalize substitution denial", () => {
  const saveAck = () =>
    receipt(
      "receiving.save",
      amendmentId,
      saveReceivingAmendmentSchema.parse(saveInput),
      amendment,
    );
  const finalizeAck = () =>
    receipt(
      "receiving.finalize",
      amendmentId,
      finalizeReceivingRevisionSchema.parse(finalizeInput),
      amendmentFinalized,
    );

  it("rejects a no-op save that changes the saved update actor or time", async () => {
    for (const update of [{ updatedBy: "other-user" }, { updatedAt: "2026-09-08T10:00:00.000Z" }]) {
      const value = saveAck();
      value.record = { ...value.record, ...update };
      receivingOperationReceiptV2Schema.parse(value);
      await expect(matchesSave(value, amendmentId, saveInput, amendment)).resolves.toBe(false);
    }
  });

  it("normalizes omitted/null exemption only for no-op comparison, not for the explicit command digest", async () => {
    const before = receivingLiveRecordSchema.parse({
      ...amendment,
      content: {
        kind: "draft",
        draft: {
          ...saveInput.draft,
          items: saveInput.draft.items.map((line) => ({ ...line, exemptReceipt: null })),
        },
      },
    });
    const input = saveReceivingAmendmentSchema.parse(saveInput);
    const value = receipt("receiving.save", amendmentId, input, before);
    await expect(matchesSave(value, amendmentId, input, before)).resolves.toBe(true);
    if (before.content.kind !== "draft") throw new Error("Expected draft");
    const explicitNull = saveReceivingAmendmentSchema.parse({
      ...input,
      draft: before.content.draft,
    });
    await expect(matchesSave(value, amendmentId, explicitNull, before)).resolves.toBe(false);
    await expect(
      matchesSave(
        receipt("receiving.save", amendmentId, explicitNull, before),
        amendmentId,
        explicitNull,
        before,
      ),
    ).resolves.toBe(true);
  });

  it("requires the exact captured record and never downgrades explicit commands into old acknowledgements", async () => {
    for (const captured of [undefined, null, {}, liveDraft, predecessor, voided(amendment)]) {
      await expect(matchesSave(saveAck(), amendmentId, saveInput, captured)).resolves.toBe(false);
      await expect(
        matchesFinalize(finalizeAck(), amendmentId, finalizeInput, captured),
      ).resolves.toBe(false);
    }
    await expect(matchesSave(record, amendmentId, saveInput, amendment)).resolves.toBe(false);
    await expect(
      matchesFinalize(liveFinalized, amendmentId, finalizeInput, amendment),
    ).resolves.toBe(false);
  });

  it.each([
    "root",
    "predecessor",
    "reason",
    "revision",
    "eventNumber",
    "timeZone",
    "creator",
    "createdAt",
    "lifecycle",
    "draftVersion",
  ])("rejects schema-valid %s substitution with the original command digest", async (field) => {
    for (const [check, input, value] of [
      [matchesSave, saveInput, saveAck()],
      [matchesFinalize, finalizeInput, finalizeAck()],
    ] as const) {
      const changed = structuredClone(value);
      if (field === "root") changed.record.lifecycle.rootId = operationKey;
      if (field === "predecessor") {
        changed.record.lifecycle.previousRevisionId = operationKey;
        if (changed.record.status === "draft")
          changed.record.lifecycle.currentEventId = operationKey;
        if (
          changed.record.content.kind === "finalized" &&
          changed.record.content.snapshot.snapshotVersion === 3
        )
          for (const line of changed.record.content.snapshot.items)
            if (line.lotBinding.kind === "retained") line.lotBinding.previousEventId = operationKey;
      }
      if (field === "reason") changed.record.lifecycle.amendmentReason = "Different reason";
      if (field === "revision") changed.record.revision = 4;
      if (field === "eventNumber") changed.record.eventNumber = "REC-26-9999";
      if (field === "timeZone") changed.record.timeZone = "America/New_York";
      if (field === "creator") changed.record.createdBy = "other-user";
      if (field === "createdAt") changed.record.createdAt = "2026-09-06T10:00:00.000Z";
      if (field === "lifecycle") changed.record.lifecycle.lifecycleVersion += 1;
      if (field === "draftVersion") changed.record.draftVersion += 1;
      receivingOperationReceiptV2Schema.parse(changed);
      await expect(check(changed, amendmentId, input, amendment)).resolves.toBe(false);
    }
  });

  it("requires a changed save to advance only the draft version and echo the exact ordered bindings", async () => {
    const input = saveReceivingAmendmentSchema.parse({
      ...saveInput,
      draft: { ...saveInput.draft, notes: "Recount completed" },
    });
    const after = receivingLiveRecordSchema.parse({
      ...amendment,
      draftVersion: 2,
      content: { kind: "draft", draft: input.draft },
    });
    const value = receipt("receiving.save", amendmentId, input, after);
    await expect(matchesSave(value, amendmentId, input, amendment)).resolves.toBe(true);
    for (const draftVersion of [1, 3])
      await expect(
        matchesSave(
          { ...value, record: { ...after, draftVersion } },
          amendmentId,
          input,
          amendment,
        ),
      ).resolves.toBe(false);
    const changed = structuredClone(value);
    if (changed.record.content.kind !== "draft") throw new Error("Expected draft");
    changed.record.content.draft.items.reverse();
    receivingOperationReceiptV2Schema.parse(changed);
    await expect(matchesSave(changed, amendmentId, input, amendment)).resolves.toBe(false);
  });

  it.each(["binding-kind", "binding-line", "lot", "product", "link-mode", "digest", "pending"])(
    "rejects schema-valid finalized %s substitution",
    async (field) => {
      const value = finalizeAck();
      if (
        value.record.content.kind !== "finalized" ||
        value.record.content.snapshot.snapshotVersion !== 3
      )
        throw new Error("Expected v3");
      const snapshot = value.record.content.snapshot;
      const line = snapshot.items[0];
      if (!line) throw new Error("Expected line");
      if (field === "binding-kind") line.lotBinding = { kind: "created" };
      if (field === "binding-line")
        line.lotBinding = { kind: "retained", previousEventId: id, previousLineNo: 99 };
      if (field === "lot") line.lotId = operationKey;
      if (field === "product") {
        line.productId = operationKey;
        line.productDescription.sourceProductId = operationKey;
      }
      if (field === "link-mode") line.lotLinkMode = "link_existing";
      if (field === "digest") snapshot.confirmation.inputDigest = "b".repeat(64);
      if (field === "pending") value.record.lifecycle.pendingDraftId = operationKey;
      receivingOperationReceiptV2Schema.parse(value);
      await expect(matchesFinalize(value, amendmentId, finalizeInput, amendment)).resolves.toBe(
        false,
      );
    },
  );

  it("correlates fresh QA review of retained exempt lines, including an own-assigned TLC", async () => {
    const previousId = exemptionRecord.id;
    const old = exemptionFinalized.snapshot;
    const before = receivingLiveRecordSchema.parse({
      ...amendment,
      lifecycle: {
        ...amendment.lifecycle,
        rootId: previousId,
        previousRevisionId: previousId,
        currentEventId: previousId,
      },
      content: {
        kind: "draft",
        draft: {
          ...exemptionRecord.draft,
          items: exemptionRecord.draft.items.map((line, index) => ({
            ...line,
            previousLineNo: index + 1,
            lotId: old.items[index]?.lotId,
          })),
        },
      },
    });
    const after = receivingLiveRecordSchema.parse({
      ...before,
      status: "finalized",
      updatedAt: exemptionFinalized.finalizedAt,
      updatedBy: exemptionFinalized.finalizedBy,
      lifecycle: {
        ...before.lifecycle,
        lifecycleVersion: 6,
        currentEventId: amendmentId,
        pendingDraftId: null,
      },
      content: {
        kind: "finalized",
        finalizedAt: exemptionFinalized.finalizedAt,
        finalizedBy: exemptionFinalized.finalizedBy,
        snapshot: {
          ...old,
          snapshotVersion: 3,
          confirmation: { ...old.confirmation, ruleVersion: "receiving-readiness-v4" },
          items: old.items.map((line) => ({
            ...line,
            lotBinding: {
              kind: "retained",
              previousEventId: previousId,
              previousLineNo: line.lineNo,
            },
          })),
        },
      },
    });
    const input = finalizeReceivingRevisionSchema.parse({
      ...finalizeInput,
      previousRevisionId: previousId,
      expectedInputDigest: old.confirmation.inputDigest,
      reviewedExemptLines: [1, 2],
    });
    await expect(
      matchesFinalize(
        receipt("receiving.finalize", amendmentId, input, after),
        amendmentId,
        input,
        before,
      ),
    ).resolves.toBe(true);
    for (const reviewedExemptLines of [[], [1], [1, 2, 3]]) {
      const otherInput = { ...input, reviewedExemptLines };
      await expect(
        matchesFinalize(
          receipt("receiving.finalize", amendmentId, otherInput, after),
          amendmentId,
          otherInput,
          before,
        ),
      ).resolves.toBe(false);
    }
  });

  it("handles explicit original finalization while retaining created versus linked lot checks", async () => {
    const before = receivingLiveRecordSchema.parse({
      ...liveDraft,
      draftVersion: 7,
      content: { kind: "draft", draft: record.draft },
    });
    const input = finalizeReceivingRevisionSchema.parse({
      ...finalizeInput,
      expectedDraftVersion: 7,
      expectedLifecycleVersion: 1,
      previousRevisionId: null,
    });
    const value = receipt("receiving.finalize", id, input, liveFinalized);
    await expect(matchesFinalize(value, id, input, before)).resolves.toBe(true);
    if (value.record.content.kind !== "finalized") throw new Error("Expected finalized");
    const linked = value.record.content.snapshot.items.find(
      (line) => line.lotLinkMode === "link_existing",
    );
    if (!linked) throw new Error("Expected linked line");
    expect(linked.lotId).toBe(lotId);
    linked.lotId = operationKey;
    receivingOperationReceiptV2Schema.parse(value);
    await expect(matchesFinalize(value, id, input, before)).resolves.toBe(false);
  });

  it("leaves active public client input gates original-only until coordinated route/UI activation", async () => {
    const send = vi.fn<typeof fetch>();
    const client = createUsBrowserClient(send);
    await expect(client.saveReceivingDraft(amendmentId, saveInput)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(client.finalizeReceiving(amendmentId, finalizeInput)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("amend/void acknowledgement substitution denial", () => {
  const amendAck = () =>
    receipt("receiving.amend", id, amendReceivingSchema.parse(amendInput), amendment);
  const voidInput = voidReceivingSchema.parse({
    commandVersion: 2,
    operationKey,
    expectedLifecycleVersion: 5,
    expectedDraftVersion: 1,
    reason,
  });
  const voidAck = () => receipt("receiving.void", amendmentId, voidInput, voided(amendment));

  it.each([finalized, exemptionFinalized])(
    "amends and voids frozen v$snapshot.snapshotVersion without converting its historical content",
    async (legacy) => {
      const before = liveFixture(legacy);
      const saved = legacy.id === record.id ? record : exemptionRecord;
      const copied = receivingLiveRecordSchema.parse({
        ...amendment,
        eventNumber: before.eventNumber,
        timeZone: before.timeZone,
        lifecycle: {
          ...amendment.lifecycle,
          rootId: before.id,
          previousRevisionId: before.id,
          currentEventId: before.id,
          lifecycleVersion: 3,
        },
        content: {
          kind: "draft",
          draft: {
            ...saved.draft,
            items: saved.draft.items.map((line, index) => ({
              ...line,
              lotId: legacy.snapshot.items[index]?.lotId,
              previousLineNo: index + 1,
            })),
          },
        },
      });
      const start = amendReceivingSchema.parse({ ...amendInput, expectedLifecycleVersion: 2 });
      const cancel = voidReceivingSchema.parse({
        ...voidInput,
        expectedLifecycleVersion: 2,
        expectedDraftVersion: null,
      });
      const pinned = JSON.stringify(legacy);
      await expect(
        matchesAmend(
          receipt("receiving.amend", before.id, start, copied),
          before.id,
          start,
          before,
        ),
      ).resolves.toBe(true);
      await expect(
        matchesVoid(
          receipt("receiving.void", before.id, cancel, voided(before)),
          before.id,
          cancel,
          before,
        ),
      ).resolves.toBe(true);
      expect(JSON.stringify(legacy)).toBe(pinned);
    },
  );

  it.each([
    "root",
    "predecessor",
    "reason",
    "lifecycle",
    "draftVersion",
    "eventNumber",
    "timeZone",
  ])(
    "rejects schema-valid %s substitution without trusting the receipt digest alone",
    async (field) => {
      for (const [check, target, input, before, value] of [
        [matchesAmend, id, amendInput, predecessor, amendAck()],
        [matchesVoid, amendmentId, voidInput, amendment, voidAck()],
      ] as const) {
        const changed = structuredClone(value);
        if (field === "root") changed.record.lifecycle.rootId = operationKey;
        if (field === "predecessor") {
          changed.record.lifecycle.previousRevisionId = operationKey;
          changed.record.lifecycle.currentEventId = operationKey;
        }
        if (field === "reason") {
          if (changed.command === "receiving.amend")
            changed.record.lifecycle.amendmentReason = "Other reason";
          else changed.record.lifecycle.voidReason = "Other reason";
        }
        if (field === "lifecycle") changed.record.lifecycle.lifecycleVersion += 1;
        if (field === "draftVersion") changed.record.draftVersion += 1;
        if (field === "eventNumber") changed.record.eventNumber = "REC-26-9999";
        if (field === "timeZone") changed.record.timeZone = "America/New_York";
        receivingOperationReceiptV2Schema.parse(changed);
        await expect(check(changed, target, input, before)).resolves.toBe(false);
      }
    },
  );

  it.each(["count", "binding", "lot", "product", "link-mode"])(
    "rejects an amendment that substitutes copied %s data",
    async (field) => {
      const value = amendAck();
      if (value.record.content.kind !== "draft") throw new Error("Expected draft");
      const lines = value.record.content.draft.items;
      const line = lines[0];
      if (!line) throw new Error("Expected line");
      if (field === "count") lines.pop();
      if (field === "binding" && "previousLineNo" in line) line.previousLineNo = 99;
      if (field === "lot") line.lotId = operationKey;
      if (field === "product") line.productId = operationKey;
      if (field === "link-mode") line.lotLinkMode = "link_existing";
      receivingOperationReceiptV2Schema.parse(value);
      await expect(matchesAmend(value, id, amendInput, predecessor)).resolves.toBe(false);
    },
  );

  it("rejects void responses that replace saved or frozen content or reopen a pending revision", async () => {
    for (const before of [amendment, amendmentFinalized]) {
      const input = voidReceivingSchema.parse({
        ...voidInput,
        expectedLifecycleVersion: before.lifecycle.lifecycleVersion,
        expectedDraftVersion: before.status === "draft" ? 1 : null,
      });
      const value = receipt("receiving.void", amendmentId, input, voided(before));
      if (value.record.content.kind === "draft")
        value.record.content.draft.notes = "Changed during void";
      else value.record.content.snapshot.notes = "Changed during void";
      receivingOperationReceiptV2Schema.parse(value);
      await expect(matchesVoid(value, amendmentId, input, before)).resolves.toBe(false);
    }
    const value = voidAck();
    value.record.lifecycle.pendingDraftId = operationKey;
    receivingOperationReceiptV2Schema.parse(value);
    await expect(matchesVoid(value, amendmentId, voidInput, amendment)).resolves.toBe(false);
  });

  it("rejects commands whose captured lifecycle/draft or predecessor differs from the sent expectation", async () => {
    const changedSave = saveReceivingAmendmentSchema.parse({
      ...saveInput,
      expectedLifecycleVersion: 6,
    });
    await expect(
      matchesSave(
        receipt("receiving.save", amendmentId, changedSave, amendment),
        amendmentId,
        changedSave,
        amendment,
      ),
    ).resolves.toBe(false);
    const changedFinalize = finalizeReceivingRevisionSchema.parse({
      ...finalizeInput,
      previousRevisionId: operationKey,
    });
    await expect(
      matchesFinalize(
        receipt("receiving.finalize", amendmentId, changedFinalize, amendmentFinalized),
        amendmentId,
        changedFinalize,
        amendment,
      ),
    ).resolves.toBe(false);
    const changedVoid = { ...voidInput, expectedDraftVersion: null };
    await expect(
      matchesVoid(
        receipt("receiving.void", amendmentId, changedVoid, voided(amendment)),
        amendmentId,
        changedVoid,
        amendment,
      ),
    ).resolves.toBe(false);
    const changedAmend = { ...amendInput, expectedLifecycleVersion: 5 };
    await expect(
      matchesAmend(
        receipt("receiving.amend", id, changedAmend, amendment),
        id,
        changedAmend,
        predecessor,
      ),
    ).resolves.toBe(false);
  });

  it("does not use today's terminal state or pending amendment to validate an earlier command", async () => {
    const pending = receivingLiveRecordSchema.parse({
      ...predecessor,
      lifecycle: { ...predecessor.lifecycle, pendingDraftId: amendmentId },
    });
    for (const captured of [null, {}, voided(predecessor), pending])
      await expect(matchesAmend(amendAck(), id, amendInput, captured)).resolves.toBe(false);
    for (const captured of [undefined, {}, voided(amendment), predecessor])
      await expect(matchesVoid(voidAck(), amendmentId, voidInput, captured)).resolves.toBe(false);
    // Exact historical retry still works with its separately retained original context.
    await expect(matchesAmend(amendAck(), id, amendInput, predecessor)).resolves.toBe(true);
    await expect(matchesVoid(voidAck(), amendmentId, voidInput, amendment)).resolves.toBe(true);
  });

  it.each(["key", "digest", "version", "extra"])(
    "rejects %s envelope substitution for every explicit command",
    async (field) => {
      for (const [check, target, input, captured, value] of [
        [
          matchesSave,
          amendmentId,
          saveInput,
          amendment,
          receipt(
            "receiving.save",
            amendmentId,
            saveReceivingAmendmentSchema.parse(saveInput),
            amendment,
          ),
        ],
        [
          matchesFinalize,
          amendmentId,
          finalizeInput,
          amendment,
          receipt(
            "receiving.finalize",
            amendmentId,
            finalizeReceivingRevisionSchema.parse(finalizeInput),
            amendmentFinalized,
          ),
        ],
        [matchesAmend, id, amendInput, predecessor, amendAck()],
        [matchesVoid, amendmentId, voidInput, amendment, voidAck()],
      ] as const) {
        const changed = {
          ...value,
          ...(field === "key" ? { operationKey: id } : {}),
          ...(field === "digest" ? { inputDigest: "0".repeat(64) } : {}),
          ...(field === "version" ? { receiptVersion: 3 } : {}),
          ...(field === "extra" ? { internal: "not public" } : {}),
        };
        await expect(check(changed, target, input, captured)).resolves.toBe(false);
      }
    },
  );

  it("fails closed without native hashing for every explicit command", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(
      matchesSave(
        receipt(
          "receiving.save",
          amendmentId,
          saveReceivingAmendmentSchema.parse(saveInput),
          amendment,
        ),
        amendmentId,
        saveInput,
        amendment,
      ),
    ).resolves.toBe(false);
    await expect(
      matchesFinalize(
        receipt(
          "receiving.finalize",
          amendmentId,
          finalizeReceivingRevisionSchema.parse(finalizeInput),
          amendmentFinalized,
        ),
        amendmentId,
        finalizeInput,
        amendment,
      ),
    ).resolves.toBe(false);
    await expect(matchesAmend(amendAck(), id, amendInput, predecessor)).resolves.toBe(false);
    await expect(matchesVoid(voidAck(), amendmentId, voidInput, amendment)).resolves.toBe(false);
  });
});
