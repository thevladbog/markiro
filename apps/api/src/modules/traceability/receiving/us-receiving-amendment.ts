import { isDeepStrictEqual } from "node:util";
import { schema } from "@markiro/db";
import { ConflictException } from "@nestjs/common";
import type { ReceivingRetainedBinding } from "@markiro/domain";
import {
  receivingDraftRecordSchema,
  type ReceivingAmendmentDraft,
  type ReceivingLiveRecord,
} from "@markiro/platform-contracts";
import { and, eq } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readReceivingLiveRecord } from "./us-receiving-history";
import { readReceivingSavedInput, unavailable } from "./us-receiving-persistence";

type Item = ReceivingAmendmentDraft["items"][number];
const handling = (line: Pick<Item, "exemptSupplier" | "exemptReceipt">) =>
  line.exemptSupplier
    ? [true, line.exemptReceipt?.tlcHandling ?? null, line.exemptReceipt?.proposedTlc ?? null]
    : [false];

/** Exact saved predecessor identity, never live labels, matching TLCs or current array position. */
export async function validateReceivingAmendment(
  tx: UsMasterDataTransaction,
  tenantId: string,
  current: ReceivingLiveRecord,
  draft: ReceivingAmendmentDraft,
  lockPredecessor = true,
) {
  const previousId = current.lifecycle.previousRevisionId;
  if (current.revision === 1 || previousId === null) throw unavailable();
  const events = schema.traceabilityEvents;
  const query = tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, previousId)));
  const [header] = await (lockPredecessor ? query.for("share") : query);
  if (
    !header ||
    header.rootEventId !== current.lifecycle.rootId ||
    header.revision >= current.revision
  )
    throw unavailable();
  const previous = await readReceivingLiveRecord(tx, tenantId, previousId);
  if (previous.content.kind !== "finalized") throw unavailable();
  const raw = await readReceivingSavedInput(tx, tenantId, header);
  // The previous revision may itself be an amendment. Its own previousLineNo
  // is not the candidate's binding; the immediate predecessor's line number is.
  const parsed = receivingDraftRecordSchema.shape.draft.safeParse({
    ...raw,
    items: raw.items.map(({ previousLineNo: _binding, ...line }) => line),
  });
  if (!parsed.success) throw unavailable();
  const predecessorDraft = parsed.data;
  const lines: { lineNo: number; fields: string[] }[] = [];
  const retainedBindings: ReceivingRetainedBinding[] = [];
  draft.items.forEach((line, index) => {
    if (line.previousLineNo === null) return;
    const old = predecessorDraft.items[line.previousLineNo - 1];
    const fields: string[] = [];
    if (!old) fields.push("previousLineNo");
    else {
      if (old.lotId === null) throw unavailable();
      for (const field of ["lotId", "productId", "tlc", "source", "lotLinkMode"] as const)
        if (!isDeepStrictEqual(line[field], old[field])) fields.push(field);
      if (!isDeepStrictEqual(handling(line), handling(old))) fields.push("receiptHandling");
      if (!fields.length)
        retainedBindings.push({
          lineNo: index + 1,
          previousLineNo: line.previousLineNo,
          lotId: old.lotId,
        });
    }
    if (fields.length) lines.push({ lineNo: index + 1, fields });
  });
  if (lines.length) throw new ConflictException({ code: "lot_identity_locked", lines });
  return { previous, predecessorDraft, retainedBindings };
}
