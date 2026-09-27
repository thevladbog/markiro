import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema } from "./event-values.js";
import { listReceivingLiveRecordsQuerySchema } from "./receiving-live-records.js";
import { receivingDraftRecordSchema } from "./receiving-records.js";
import { shippingDraftRecordSchema } from "./shipping-records.js";
import { transformationDraftRecordSchema } from "./transformation-records.js";

const version = z.number().int().min(1).max(2147483647);
const count = z.number().int().min(0).max(100);
const page = {
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(100000),
};
const common = {
  id: platformUuidSchema,
  rootId: platformUuidSchema,
  revision: version,
  status: listReceivingLiveRecordsQuerySchema.shape.status.unwrap(),
  lifecycleVersion: version,
  currentEventId: platformUuidSchema.nullable(),
  pendingDraftId: platformUuidSchema.nullable(),
  eventDate: traceabilityCivilDateSchema.nullable(),
  timeZone: transformationDraftRecordSchema.shape.timeZone,
  locationId: platformUuidSchema.nullable(),
  locationDisplay: z.string().min(1).max(2000).nullable(),
  documentCount: count,
  updatedAt: z.iso.datetime(),
};
const receivingSummary = z
  .object({
    ...common,
    type: z.literal("receiving"),
    eventNumber: receivingDraftRecordSchema.shape.eventNumber,
    lineCount: count,
    previousSourceLocationId: platformUuidSchema.nullable(),
  })
  .strict();
const transformationSummary = z
  .object({
    ...common,
    type: z.literal("transformation"),
    eventNumber: transformationDraftRecordSchema.shape.eventNumber,
    inputCount: count,
    outputCount: count,
  })
  .strict();
const shippingSummary = z
  .object({
    ...common,
    type: z.literal("shipping"),
    eventNumber: shippingDraftRecordSchema.shape.eventNumber,
    lineCount: count,
  })
  .strict();

export const usEventListQuerySchema = listReceivingLiveRecordsQuerySchema
  .pick({ limit: true, offset: true, search: true, status: true, history: true })
  .safeExtend({ type: z.enum(["all", "receiving", "transformation", "shipping"]).default("all") })
  .strict();
const summary = z
  .discriminatedUnion("type", [receivingSummary, transformationSummary, shippingSummary])
  .superRefine((row, context) => {
    const sameId = (left: string | null, right: string) =>
      left !== null && left.toLowerCase() === right.toLowerCase();
    const fail = (field: string) =>
      context.addIssue({ code: "custom", path: [field], message: "Event identity mismatch" });
    if ((row.revision === 1) !== sameId(row.id, row.rootId)) fail("rootId");
    if (row.currentEventId !== null && sameId(row.currentEventId, row.pendingDraftId ?? ""))
      fail("pendingDraftId");
    if (row.status === "draft") {
      if (!sameId(row.pendingDraftId, row.id)) fail("pendingDraftId");
      if (row.revision === 1 ? row.currentEventId !== null : row.currentEventId === null)
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
export const usEventListSchema = z
  .object({
    items: z.array(summary).max(100),
    ...page,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.items.length > value.limit)
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Item count exceeds response limit",
      });
    const ids = new Set<string>();
    const roots = new Map<string, (typeof value.items)[number]>();
    value.items.forEach((item, index) => {
      const id = item.id.toLowerCase();
      const rootId = item.rootId.toLowerCase();
      const first = roots.get(rootId);
      if (
        ids.has(id) ||
        (first !== undefined &&
          (first.type !== item.type ||
            first.eventNumber !== item.eventNumber ||
            first.timeZone !== item.timeZone ||
            first.lifecycleVersion !== item.lifecycleVersion ||
            first.currentEventId?.toLowerCase() !== item.currentEventId?.toLowerCase() ||
            first.pendingDraftId?.toLowerCase() !== item.pendingDraftId?.toLowerCase()))
      )
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Registry must contain unique revisions from consistent root snapshots",
        });
      ids.add(id);
      roots.set(rootId, item);
    });
  });

export type UsEventListQuery = z.infer<typeof usEventListQuerySchema>;
export type UsEventSummary = z.infer<typeof summary>;
export type UsEventList = z.infer<typeof usEventListSchema>;
