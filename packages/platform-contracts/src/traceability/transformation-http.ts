import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { listReceivingLiveRecordsQuerySchema } from "./receiving-live-records.js";
import { transformationHistoricalRecordSchema } from "./transformation-lifecycle.js";
import { transformationIssueSchema } from "./transformation-readiness.js";
import { transformationDraftRecordSchema } from "./transformation-records.js";

const version = z.number().int().min(1).max(2147483647);
const page = {
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(100000),
};
const reason = z.string().trim().min(1).max(2000).nullable();

export const transformationHttpRecordSchema = z.union([
  transformationDraftRecordSchema,
  transformationHistoricalRecordSchema,
]);
export const transformationRevisionListQuerySchema = listReceivingLiveRecordsQuerySchema
  .pick({ limit: true, offset: true })
  .strict();

const revisionSummary = z
  .object({
    id: platformUuidSchema,
    rootId: platformUuidSchema,
    eventNumber: transformationDraftRecordSchema.shape.eventNumber,
    revision: version,
    status: listReceivingLiveRecordsQuerySchema.shape.status.unwrap(),
    timeZone: transformationDraftRecordSchema.shape.timeZone,
    lifecycleVersion: version,
    currentEventId: platformUuidSchema.nullable(),
    pendingDraftId: platformUuidSchema.nullable(),
    previousRevisionId: platformUuidSchema.nullable(),
    amendmentReason: reason,
    voidReason: reason,
  })
  .strict()
  .superRefine((row, context) => {
    const sameId = (left: string | null, right: string) =>
      left !== null && left.toLowerCase() === right.toLowerCase();
    const fail = (field: string) =>
      context.addIssue({ code: "custom", path: [field], message: "Revision identity mismatch" });
    if ((row.revision === 1) !== sameId(row.id, row.rootId)) fail("rootId");
    if (row.revision === 1) {
      if (row.previousRevisionId !== null || row.amendmentReason !== null)
        fail("previousRevisionId");
    } else if (
      row.previousRevisionId === null ||
      row.amendmentReason === null ||
      sameId(row.previousRevisionId, row.id)
    )
      fail("previousRevisionId");
    if (row.currentEventId !== null && sameId(row.currentEventId, row.pendingDraftId ?? ""))
      fail("pendingDraftId");
    if (row.status === "draft") {
      if (!sameId(row.pendingDraftId, row.id)) fail("pendingDraftId");
      if (
        row.revision === 1
          ? row.currentEventId !== null
          : !sameId(row.currentEventId, row.previousRevisionId ?? "")
      )
        fail("currentEventId");
    } else {
      if (sameId(row.pendingDraftId, row.id)) fail("pendingDraftId");
      if (
        row.status === "finalized"
          ? !sameId(row.currentEventId, row.id)
          : sameId(row.currentEventId, row.id)
      )
        fail("currentEventId");
    }
  });

export const transformationRevisionListSchema = z
  .object({
    items: z.array(revisionSummary).max(100),
    ...page,
    lifecycleVersion: version,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.limit)
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item count exceeds response limit",
      });
    const first = value.items[0];
    const ids = new Set<string>();
    value.items.forEach((item, index) => {
      const id = item.id.toLowerCase();
      if (
        ids.has(id) ||
        item.lifecycleVersion !== value.lifecycleVersion ||
        (first !== undefined &&
          (first.rootId.toLowerCase() !== item.rootId.toLowerCase() ||
            first.eventNumber !== item.eventNumber ||
            first.timeZone !== item.timeZone ||
            first.currentEventId?.toLowerCase() !== item.currentEventId?.toLowerCase() ||
            first.pendingDraftId?.toLowerCase() !== item.pendingDraftId?.toLowerCase())) ||
        (index > 0 && item.revision <= (value.items[index - 1]?.revision ?? 0))
      )
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "History must contain unique ascending revisions of one root snapshot",
        });
      ids.add(id);
    });
  });

const blocker = z
  .object({
    lotId: platformUuidSchema,
    eventId: platformUuidSchema,
    rootId: platformUuidSchema,
    revision: version,
  })
  .strict();

export const transformationHttpErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.enum([
        "transformation_not_found",
        "transformation_reference_not_found",
        "transformation_not_draft",
        "transformation_draft_conflict",
        "transformation_lifecycle_conflict",
        "transformation_operation_conflict",
        "transformation_readiness_changed",
        "transformation_output_identity_locked",
        "transformation_lot_conflict",
        "transformation_genealogy_cycle",
      ]),
    })
    .strict(),
  z
    .object({
      code: z.literal("transformation_pending_amendment"),
      pendingDraftId: platformUuidSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal("event_incomplete"),
      issues: z.array(transformationIssueSchema).max(5000),
    })
    .strict(),
  z
    .object({
      code: z.literal("traceability_downstream_blocked"),
      blockers: z.array(blocker).max(100),
      hasMore: z.boolean(),
    })
    .strict(),
]);

export type TransformationHttpRecord = z.infer<typeof transformationHttpRecordSchema>;
export type TransformationRevisionSummary = z.infer<typeof revisionSummary>;
export type TransformationRevisionListQuery = z.infer<typeof transformationRevisionListQuerySchema>;
export type TransformationRevisionList = z.infer<typeof transformationRevisionListSchema>;
export type TransformationHttpError = z.infer<typeof transformationHttpErrorSchema>;
