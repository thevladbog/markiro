import type { ReceivingLiveRecord } from "@markiro/platform-contracts";

export type ReceivingDraftView = ReceivingLiveRecord & {
  content: Extract<ReceivingLiveRecord["content"], { kind: "draft" }>;
};
export type ReceivingFrozenView = ReceivingLiveRecord & {
  content: Extract<ReceivingLiveRecord["content"], { kind: "finalized" }>;
};
export function isReceivingDraftView(record: ReceivingLiveRecord): record is ReceivingDraftView {
  return record.content.kind === "draft";
}
export function isReceivingFrozenView(record: ReceivingLiveRecord): record is ReceivingFrozenView {
  return record.content.kind === "finalized";
}
