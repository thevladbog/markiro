import {
  amendReceivingSchema,
  createReceivingDraftSchema,
  finalizeReceivingSchema,
  finalizeReceivingRevisionSchema,
  platformUuidSchema,
  receivingLiveRecordSchema,
  receivingOperationReceiptV2Schema,
  receivingCreateResultSchema,
  receivingSaveResultSchema,
  receivingFinalizeResultSchema,
  saveReceivingDraftSchema,
  saveReceivingAmendmentSchema,
  voidReceivingSchema,
  type ReceivingDraft,
  type ReceivingLiveRecord,
  type ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";

function sameDraft(left: ReceivingDraft, right: ReceivingDraft): boolean {
  const comparable = (draft: ReceivingDraft) => ({
    ...draft,
    items: draft.items.map(({ exemptReceipt, ...item }) => ({
      ...item,
      exemptReceipt: exemptReceipt ?? null,
    })),
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

async function matchesReceipt(
  receipt: ReceivingOperationReceiptV2,
  command: ReceivingOperationReceiptV2["command"],
  eventId: string,
  input: { operationKey: string },
  resultEventId = eventId,
) {
  if (
    receipt.command !== command ||
    receipt.operationKey.toLowerCase() !== input.operationKey ||
    receipt.eventId.toLowerCase() !== resultEventId
  )
    return false;
  try {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ commandVersion: 2, command, eventId, input }),
    );
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return (
      receipt.inputDigest ===
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    );
  } catch {
    // No fallback that could accept an uncorrelated response; no raw errors retained.
    return false;
  }
}

/** Validate historical acknowledgements, never current state.
 * Explicit revision commands require the record captured before sending, not a later live GET.
 * Parsing input restores server field order; it never changes the saved response or digest.
 */
export async function matchesReceivingCreateAcknowledgement(value: unknown, input: unknown) {
  const body = createReceivingDraftSchema.safeParse(input);
  const result = receivingCreateResultSchema.safeParse(value);
  if (!body.success || !result.success) return false;
  const ack = result.data;
  if (!("receiptVersion" in ack))
    return ack.draftVersion === 1 && sameDraft(ack.draft, body.data.draft);
  const record = ack.record;
  return (
    record.draftVersion === 1 &&
    record.lifecycle.lifecycleVersion === 1 &&
    record.content.kind === "draft" &&
    sameDraft(record.content.draft, body.data.draft) &&
    matchesReceipt(ack, "receiving.create", ack.eventId.toLowerCase(), body.data)
  );
}

export async function matchesReceivingSaveAcknowledgement(
  value: unknown,
  id: unknown,
  input: unknown,
  captured?: unknown,
) {
  const revision = saveReceivingAmendmentSchema.safeParse(input);
  if (revision.success) return matchesAmendmentSave(value, id, revision.data, captured);
  const eventId = platformUuidSchema.safeParse(id);
  const body = saveReceivingDraftSchema.safeParse(input);
  const result = receivingSaveResultSchema.safeParse(value);
  if (!eventId.success || !body.success || !result.success) return false;
  const ack = result.data;
  const record = "receiptVersion" in ack ? ack.record : ack;
  if (
    record.id.toLowerCase() !== eventId.data ||
    record.revision !== 1 ||
    (record.draftVersion !== body.data.expectedDraftVersion &&
      record.draftVersion !== body.data.expectedDraftVersion + 1)
  )
    return false;
  if (!("receiptVersion" in ack)) return sameDraft(ack.draft, body.data.draft);
  return (
    ack.record.lifecycle.lifecycleVersion === 1 &&
    ack.record.content.kind === "draft" &&
    sameDraft(ack.record.content.draft, body.data.draft) &&
    matchesReceipt(ack, "receiving.save", eventId.data, body.data)
  );
}

export async function matchesReceivingFinalizeAcknowledgement(
  value: unknown,
  id: unknown,
  input: unknown,
  captured?: unknown,
) {
  const revision = finalizeReceivingRevisionSchema.safeParse(input);
  if (revision.success) return matchesRevisionFinalize(value, id, revision.data, captured);
  const eventId = platformUuidSchema.safeParse(id);
  const body = finalizeReceivingSchema.safeParse(input);
  const result = receivingFinalizeResultSchema.safeParse(value);
  if (!eventId.success || !body.success || !result.success) return false;
  const ack = result.data;
  const record = "receiptVersion" in ack ? ack.record : ack;
  if (
    record.id.toLowerCase() !== eventId.data ||
    record.revision !== 1 ||
    record.draftVersion !== body.data.expectedDraftVersion
  )
    return false;
  if (
    "receiptVersion" in ack &&
    (ack.record.lifecycle.lifecycleVersion !== 2 ||
      ack.record.lifecycle.pendingDraftId !== null ||
      ack.record.content.kind !== "finalized" ||
      ack.record.content.snapshot.snapshotVersion !== 3)
  )
    return false;
  const snapshot =
    "receiptVersion" in ack
      ? ack.record.content.kind === "finalized"
        ? ack.record.content.snapshot
        : null
      : ack.snapshot;
  if (!snapshot) return false;
  const expected = body.data.reviewedExemptLines ?? [];
  const confirmed = snapshot.snapshotVersion === 1 ? [] : snapshot.confirmation.reviewedExemptLines;
  return (
    snapshot.confirmation.inputDigest === body.data.expectedInputDigest &&
    expected.length === confirmed.length &&
    expected.every((line, index) => line === confirmed[index]) &&
    (!("receiptVersion" in ack) ||
      matchesReceipt(ack, "receiving.finalize", eventId.data, body.data))
  );
}

const sameId = (left: string | null, right: string | null) =>
  left?.toLowerCase() === right?.toLowerCase();

function capturedRecord(id: unknown, captured: unknown, expectedLifecycleVersion: number) {
  const eventId = platformUuidSchema.safeParse(id);
  const before = receivingLiveRecordSchema.safeParse(captured);
  if (
    !eventId.success ||
    !before.success ||
    !sameId(before.data.id, eventId.data) ||
    before.data.lifecycle.lifecycleVersion !== expectedLifecycleVersion
  )
    return null;
  return before.data;
}

function sameRevisionIdentity(record: ReceivingLiveRecord, before: ReceivingLiveRecord) {
  return (
    sameId(record.id, before.id) &&
    sameId(record.lifecycle.rootId, before.lifecycle.rootId) &&
    sameId(record.lifecycle.previousRevisionId, before.lifecycle.previousRevisionId) &&
    record.lifecycle.amendmentReason === before.lifecycle.amendmentReason &&
    record.revision === before.revision &&
    record.eventNumber === before.eventNumber &&
    record.timeZone === before.timeZone &&
    record.createdAt === before.createdAt &&
    record.createdBy === before.createdBy
  );
}

async function matchesAmendmentSave(
  value: unknown,
  id: unknown,
  input: ReturnType<typeof saveReceivingAmendmentSchema.parse>,
  captured: unknown,
) {
  const before = capturedRecord(id, captured, input.expectedLifecycleVersion);
  const result = receivingOperationReceiptV2Schema.safeParse(value);
  if (
    !before ||
    !result.success ||
    before.status !== "draft" ||
    before.revision === 1 ||
    before.content.kind !== "draft" ||
    before.draftVersion !== input.expectedDraftVersion
  )
    return false;
  const ack = result.data;
  const record = ack.record;
  const expectedVersion =
    input.expectedDraftVersion + (sameDraft(before.content.draft, input.draft) ? 0 : 1);
  return (
    sameRevisionIdentity(record, before) &&
    record.draftVersion === expectedVersion &&
    (expectedVersion !== before.draftVersion ||
      (record.updatedAt === before.updatedAt && record.updatedBy === before.updatedBy)) &&
    record.lifecycle.lifecycleVersion === input.expectedLifecycleVersion &&
    record.content.kind === "draft" &&
    sameDraft(record.content.draft, input.draft) &&
    matchesReceipt(ack, "receiving.save", before.id.toLowerCase(), input)
  );
}

async function matchesRevisionFinalize(
  value: unknown,
  id: unknown,
  input: ReturnType<typeof finalizeReceivingRevisionSchema.parse>,
  captured: unknown,
) {
  const before = capturedRecord(id, captured, input.expectedLifecycleVersion);
  const result = receivingOperationReceiptV2Schema.safeParse(value);
  if (
    !before ||
    !result.success ||
    before.status !== "draft" ||
    before.content.kind !== "draft" ||
    before.draftVersion !== input.expectedDraftVersion ||
    !sameId(before.lifecycle.previousRevisionId, input.previousRevisionId)
  )
    return false;
  const ack = result.data;
  const record = ack.record;
  if (
    !sameRevisionIdentity(record, before) ||
    record.draftVersion !== input.expectedDraftVersion ||
    record.lifecycle.lifecycleVersion !== input.expectedLifecycleVersion + 1 ||
    record.lifecycle.pendingDraftId !== null ||
    record.content.kind !== "finalized" ||
    record.content.snapshot.snapshotVersion !== 3
  )
    return false;
  const snapshot = record.content.snapshot;
  const confirmed = snapshot.confirmation.reviewedExemptLines;
  const savedItems = before.content.draft.items;
  return (
    snapshot.confirmation.inputDigest === input.expectedInputDigest &&
    confirmed.length === input.reviewedExemptLines.length &&
    confirmed.every((line, index) => line === input.reviewedExemptLines[index]) &&
    snapshot.items.length === savedItems.length &&
    snapshot.items.every((line, index) => {
      const saved = savedItems[index];
      if (
        !saved ||
        !sameId(line.productId, saved.productId) ||
        line.lotLinkMode !== saved.lotLinkMode
      )
        return false;
      const previousLineNo = "previousLineNo" in saved ? saved.previousLineNo : null;
      const binding = line.lotBinding;
      if (previousLineNo !== null)
        return (
          binding.kind === "retained" &&
          sameId(binding.previousEventId, input.previousRevisionId) &&
          binding.previousLineNo === previousLineNo &&
          sameId(line.lotId, saved.lotId)
        );
      return (
        binding.kind === (saved.lotLinkMode === "link_existing" ? "linked" : "created") &&
        (saved.lotLinkMode !== "link_existing" || sameId(line.lotId, saved.lotId))
      );
    }) &&
    matchesReceipt(ack, "receiving.finalize", before.id.toLowerCase(), input)
  );
}

export async function matchesReceivingAmendAcknowledgement(
  value: unknown,
  id: unknown,
  input: unknown,
  captured: unknown,
) {
  const body = amendReceivingSchema.safeParse(input);
  const result = receivingOperationReceiptV2Schema.safeParse(value);
  if (!body.success || !result.success) return false;
  const before = capturedRecord(id, captured, body.data.expectedLifecycleVersion);
  if (
    !before ||
    before.status !== "finalized" ||
    before.lifecycle.pendingDraftId !== null ||
    before.content.kind !== "finalized"
  )
    return false;
  const ack = result.data;
  const record = ack.record;
  const previousItems = before.content.snapshot.items;
  return (
    !sameId(record.id, before.id) &&
    sameId(record.lifecycle.rootId, before.lifecycle.rootId) &&
    sameId(record.lifecycle.previousRevisionId, before.id) &&
    record.lifecycle.amendmentReason === body.data.reason &&
    record.lifecycle.lifecycleVersion === body.data.expectedLifecycleVersion + 1 &&
    // Cancelled drafts consume revision numbers; nextRevision is server-owned.
    record.revision > before.revision &&
    record.draftVersion === 1 &&
    record.eventNumber === before.eventNumber &&
    record.timeZone === before.timeZone &&
    record.createdAt === record.updatedAt &&
    record.createdBy === record.updatedBy &&
    record.content.kind === "draft" &&
    record.content.draft.items.length === previousItems.length &&
    record.content.draft.items.every((line, index) => {
      const previous = previousItems[index];
      return (
        previous !== undefined &&
        "previousLineNo" in line &&
        line.previousLineNo === previous.lineNo &&
        sameId(line.productId, previous.productId) &&
        line.lotLinkMode === previous.lotLinkMode &&
        sameId(line.lotId, previous.lotId)
      );
    }) &&
    // Amend hashes the requested predecessor, but acknowledges the newly allocated draft.
    matchesReceipt(
      ack,
      "receiving.amend",
      before.id.toLowerCase(),
      body.data,
      record.id.toLowerCase(),
    )
  );
}

export async function matchesReceivingVoidAcknowledgement(
  value: unknown,
  id: unknown,
  input: unknown,
  captured: unknown,
) {
  const body = voidReceivingSchema.safeParse(input);
  const result = receivingOperationReceiptV2Schema.safeParse(value);
  if (!body.success || !result.success) return false;
  const before = capturedRecord(id, captured, body.data.expectedLifecycleVersion);
  if (
    !before ||
    (before.status !== "draft" && before.status !== "finalized") ||
    (before.status === "finalized" && before.lifecycle.pendingDraftId !== null) ||
    body.data.expectedDraftVersion !== (before.status === "draft" ? before.draftVersion : null)
  )
    return false;
  const ack = result.data;
  const record = ack.record;
  return (
    sameRevisionIdentity(record, before) &&
    record.draftVersion === before.draftVersion &&
    record.lifecycle.lifecycleVersion === body.data.expectedLifecycleVersion + 1 &&
    record.lifecycle.voidReason === body.data.reason &&
    record.lifecycle.pendingDraftId === null &&
    sameId(
      record.lifecycle.currentEventId,
      before.status === "draft" ? before.lifecycle.currentEventId : null,
    ) &&
    record.updatedAt === before.updatedAt &&
    record.updatedBy === before.updatedBy &&
    JSON.stringify(record.content) === JSON.stringify(before.content) &&
    matchesReceipt(ack, "receiving.void", before.id.toLowerCase(), body.data)
  );
}
