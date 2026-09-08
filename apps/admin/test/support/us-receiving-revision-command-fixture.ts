import {
  receivingLiveRecordSchema,
  type ReceivingAmendmentDraft,
} from "@markiro/platform-contracts";
import { liveFinalized } from "./us-receiving-command-fixture.js";
import { id, lotId, operationKey, record } from "./us-receiving-finalization-fixture.js";

export const amendmentId = "e0000000-0000-4000-8000-000000000001";
export const reason = "Recount Ä/𐐀";
export const predecessor = receivingLiveRecordSchema.parse({
  ...liveFinalized,
  lifecycle: { ...liveFinalized.lifecycle, lifecycleVersion: 4 },
});
export const amendmentDraft: ReceivingAmendmentDraft = {
  ...record.draft,
  items: record.draft.items.map((item, index) => ({
    ...item,
    lotId,
    previousLineNo: index + 1,
  })),
};
const { draft: unusedDraft, ...draftHeader } = record;
void unusedDraft;
export const amendment = receivingLiveRecordSchema.parse({
  ...draftHeader,
  recordVersion: 2,
  id: amendmentId,
  // Revision 2 was cancelled; allocation must not assume predecessor + 1.
  revision: 3,
  draftVersion: 1,
  lifecycle: {
    ...predecessor.lifecycle,
    lifecycleVersion: 5,
    previousRevisionId: id,
    currentEventId: id,
    pendingDraftId: amendmentId,
    amendmentReason: reason,
  },
  content: { kind: "draft", draft: amendmentDraft },
});
export const amendmentFinalized = receivingLiveRecordSchema.parse({
  ...amendment,
  status: "finalized",
  updatedAt: liveFinalized.updatedAt,
  updatedBy: liveFinalized.updatedBy,
  lifecycle: {
    ...amendment.lifecycle,
    lifecycleVersion: 6,
    currentEventId: amendmentId,
    pendingDraftId: null,
  },
  content:
    liveFinalized.content.kind === "finalized"
      ? {
          ...liveFinalized.content,
          snapshot: {
            ...liveFinalized.content.snapshot,
            items: liveFinalized.content.snapshot.items.map((item) => ({
              ...item,
              lotBinding: {
                kind: "retained",
                previousEventId: id,
                previousLineNo: item.lineNo,
              },
            })),
          },
        }
      : null,
});
export const amendInput = {
  commandVersion: 2,
  operationKey,
  expectedLifecycleVersion: 4,
  reason,
};
export const saveInput = {
  commandVersion: 2,
  operationKey,
  expectedLifecycleVersion: 5,
  expectedDraftVersion: 1,
  draft: amendmentDraft,
};
export const finalizeInput = {
  commandVersion: 2,
  operationKey,
  expectedLifecycleVersion: 5,
  expectedDraftVersion: 1,
  previousRevisionId: id,
  expectedInputDigest: "a".repeat(64),
  reviewedExemptLines: [],
};
