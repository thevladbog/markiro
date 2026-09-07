import { ConflictException } from "@nestjs/common";
import type { ReceivingRetainedBinding } from "@markiro/domain";
import type { ReceivingAmendmentDraft } from "@markiro/platform-contracts";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "./us-receiving-history";
import { validateReceivingAmendment } from "./us-receiving-amendment";
import { unavailable } from "./us-receiving-persistence";

/** Reads saved inputs without pretending that an amendment is an original record. */
export async function readReceivingWorkingDraft(
  tx: UsMasterDataTransaction,
  tenantId: string,
  id: string,
  expectedDraftVersion: number,
) {
  const record = await readReceivingLiveRecord(tx, tenantId, id);
  if (record.status !== "draft" || record.content.kind !== "draft")
    throw new ConflictException({
      code: "receiving_lifecycle_conflict",
      rootId: record.lifecycle.rootId,
      lifecycleVersion: record.lifecycle.lifecycleVersion,
      currentEventId: record.lifecycle.currentEventId,
      pendingDraftId: record.lifecycle.pendingDraftId,
    });
  if (record.draftVersion !== expectedDraftVersion)
    throw new ConflictException({ code: "receiving_draft_conflict" });
  const retainedBindings: ReceivingRetainedBinding[] = [];
  if (record.revision === 1)
    return { record, draft: record.content.draft, predecessor: null, retainedBindings };
  const draft: ReceivingAmendmentDraft = {
    ...record.content.draft,
    items: record.content.draft.items.map((line) => {
      // The live envelope has already validated the pinned saved schema. Preserve
      // its bytes; entry schemas with text transforms must not reinterpret history.
      if (
        !("previousLineNo" in line) ||
        (line.previousLineNo !== null && typeof line.previousLineNo !== "number")
      )
        throw unavailable();
      return { ...line, previousLineNo: line.previousLineNo };
    }),
  };
  const validated = await validateReceivingAmendment(tx, tenantId, record, draft, false);
  return {
    record,
    draft,
    predecessor: { record: validated.previous, draft: validated.predecessorDraft },
    retainedBindings: validated.retainedBindings,
  };
}
