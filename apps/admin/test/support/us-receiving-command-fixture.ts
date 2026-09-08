import type {
  ReceivingDraft,
  ReceivingLiveRecord,
  ReceivingOperationReceiptV2,
} from "@markiro/platform-contracts";
import { finalized, id, operationKey, record } from "./us-receiving-finalization-fixture.js";

export const draft: ReceivingDraft = {
  dateReceived: null,
  locationId: null,
  previousSourceLocationId: null,
  receivedAtNote: null,
  notes: "Receipt Ä/𐐀",
  items: [],
  documentIds: [],
};
const { draft: unusedDraft, ...draftHeader } = record;
void unusedDraft;
export const liveDraft: ReceivingLiveRecord = {
  ...draftHeader,
  recordVersion: 2,
  draftVersion: 1,
  lifecycle: {
    rootId: id,
    lifecycleVersion: 1,
    previousRevisionId: null,
    supersededByEventId: null,
    currentEventId: null,
    pendingDraftId: id,
    amendmentReason: null,
    supersededAt: null,
    supersededBy: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  },
  content: { kind: "draft", draft },
};
const { snapshot, finalizedAt, finalizedBy, ...header } = finalized;
export const liveFinalized: ReceivingLiveRecord = {
  ...header,
  recordVersion: 2,
  lifecycle: {
    ...liveDraft.lifecycle,
    lifecycleVersion: 2,
    currentEventId: id,
    pendingDraftId: null,
  },
  content: {
    kind: "finalized",
    finalizedAt,
    finalizedBy,
    snapshot: {
      ...snapshot,
      snapshotVersion: 3,
      items: snapshot.items.map((item) => ({
        ...item,
        receiptBasis: { kind: "ordinary" },
        lotBinding: { kind: item.lotLinkMode === "link_existing" ? "linked" : "created" },
      })),
      confirmation: {
        ...snapshot.confirmation,
        ruleVersion: "receiving-readiness-v4",
        reviewedExemptLines: [],
      },
    },
  },
};

// Literal SHA-256 vectors of the server's versioned JSON frame, including UTF-8.
// Never compute these expectations through the browser validator under test.
export const createReceipt: ReceivingOperationReceiptV2 = {
  receiptVersion: 2,
  command: "receiving.create",
  operationKey,
  inputDigest: "8b25dc8b2d8e8acf2a6227fe2ab69d751e164bfa7a2de05a6f4198efac415cc5",
  eventId: id,
  record: liveDraft,
};
export const saveReceipt: ReceivingOperationReceiptV2 = {
  ...createReceipt,
  command: "receiving.save",
  inputDigest: "f307ff162c2c9ae20df4caffda38469ab84430624e615744a82c3c46de233a7a",
  record: { ...liveDraft, draftVersion: 8 },
};
export const finalizeReceipt: ReceivingOperationReceiptV2 = {
  ...createReceipt,
  command: "receiving.finalize",
  inputDigest: "d5a9c94799a4ab5fb077aa966e3c0773f686cbc190151dbef6a223c2bf4073c9",
  record: liveFinalized,
};
