import { z } from "zod";
import { receivingDraftRecordSchema, listReceivingDraftsQuerySchema } from "./receiving-records.js";
import {
  receivingFinalizedRecordSchema,
  receivingFinalizationSnapshotSchema,
} from "./receiving-finalization.js";
import { receivingFinalizationSnapshotV3Schema } from "./receiving-finalization-v3.js";

const version = z.number().int().min(1).max(2147483647);
const lineNumber = z.number().int().min(1).max(100);
const pinnedText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine(
      (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
    );
const actor = pinnedText(128);
const reason = pinnedText(2000);
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const matches = (a: string | null, b: string) => a !== null && sameId(a, b);
const old = receivingDraftRecordSchema.shape;
const lifecycleSchema = z
  .object({
    rootId: z.uuid(),
    lifecycleVersion: version,
    previousRevisionId: z.uuid().nullable(),
    supersededByEventId: z.uuid().nullable(),
    currentEventId: z.uuid().nullable(),
    pendingDraftId: z.uuid().nullable(),
    amendmentReason: reason.nullable(),
    supersededAt: z.iso.datetime().nullable(),
    supersededBy: actor.nullable(),
    voidedAt: z.iso.datetime().nullable(),
    voidedBy: actor.nullable(),
    voidReason: reason.nullable(),
  })
  .strict();

const identitySchema = z
  .object({
    recordVersion: z.literal(2),
    id: old.id,
    eventNumber: old.eventNumber,
    revision: version,
    draftVersion: version,
    timeZone: z.string().refine((value) => {
      const parsed = old.timeZone.safeParse(value);
      return parsed.success && parsed.data === value;
    }),
    createdBy: actor,
    updatedBy: actor,
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
    status: z.enum(["draft", "finalized", "amended", "void"]),
    lifecycle: lifecycleSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const l = value.lifecycle;
    const fail = (field: string, message: string) =>
      context.addIssue({ code: "custom", path: ["lifecycle", field], message });
    if ((value.revision === 1) !== sameId(value.id, l.rootId))
      fail("rootId", "Original revision and root identity disagree");
    if (value.revision === 1) {
      if (l.previousRevisionId !== null || l.amendmentReason !== null)
        fail("previousRevisionId", "An original revision has no predecessor or amendment reason");
    } else if (
      l.previousRevisionId === null ||
      l.amendmentReason === null ||
      matches(l.previousRevisionId, value.id)
    )
      fail("previousRevisionId", "An amendment requires a distinct predecessor and reason");
    if (matches(l.supersededByEventId, value.id))
      fail("supersededByEventId", "A revision cannot supersede itself");
    if (l.currentEventId !== null && matches(l.pendingDraftId, l.currentEventId))
      fail("pendingDraftId", "Current and pending revisions must be distinct");

    const supersession = [l.supersededByEventId, l.supersededAt, l.supersededBy];
    if (
      value.status === "amended"
        ? supersession.some((field) => field === null)
        : supersession.some((field) => field !== null)
    )
      fail("supersededByEventId", "Only amended revisions have complete supersession metadata");
    const voidMetadata = [l.voidedAt, l.voidedBy, l.voidReason];
    if (
      value.status === "void"
        ? voidMetadata.some((field) => field === null)
        : voidMetadata.some((field) => field !== null)
    )
      fail("voidReason", "Only void revisions have complete void metadata");

    if (value.status === "draft") {
      if (!matches(l.pendingDraftId, value.id))
        fail("pendingDraftId", "A draft must be the root's pending revision");
      if (
        value.revision === 1
          ? l.currentEventId !== null
          : l.previousRevisionId === null || !matches(l.currentEventId, l.previousRevisionId)
      )
        fail("currentEventId", "An amendment draft must retain its current predecessor");
    } else {
      if (matches(l.pendingDraftId, value.id))
        fail("pendingDraftId", "A non-draft cannot be pending");
      if (
        value.status === "finalized"
          ? !matches(l.currentEventId, value.id)
          : matches(l.currentEventId, value.id)
      )
        fail("currentEventId", "Current pointer must agree with finalized status");
    }
  });

const pinnedDraft = old.draft;
const pinnedAmendmentDraft = pinnedDraft
  .extend({
    items: z
      .array(
        pinnedDraft.shape.items.element.extend({ previousLineNo: lineNumber.nullable() }).strict(),
      )
      .max(100)
      .refine((items) => {
        const bindings = items.flatMap((item) =>
          item.previousLineNo === null ? [] : [item.previousLineNo],
        );
        return bindings.length === new Set(bindings).size;
      }, "Duplicate predecessor line binding"),
  })
  .strict();
const contentSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("draft"), draft: z.union([pinnedDraft, pinnedAmendmentDraft]) })
    .strict(),
  z
    .object({
      kind: z.literal("finalized"),
      finalizedAt: z.iso.datetime(),
      finalizedBy: actor,
      snapshot: z.union([
        receivingFinalizationSnapshotSchema,
        receivingFinalizationSnapshotV3Schema,
      ]),
    })
    .strict(),
]);

/** Current lifecycle is independent of frozen content and of historical operation receipts. */
export const receivingLiveRecordSchema = identitySchema
  .safeExtend({ content: contentSchema })
  .superRefine((value, context) => {
    const content = value.content;
    const fail = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    if (
      (value.status === "draft" && content.kind !== "draft") ||
      ((value.status === "finalized" || value.status === "amended") && content.kind !== "finalized")
    )
      fail(["content"], "Content kind disagrees with the revision lifecycle");
    if (content.kind === "draft") {
      const parsed = (value.revision === 1 ? pinnedDraft : pinnedAmendmentDraft).safeParse(
        content.draft,
      );
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          context.addIssue({ ...issue, path: ["content", "draft", ...issue.path] });
      if (
        value.status === "void" &&
        value.revision === 1 &&
        (value.lifecycle.currentEventId !== null || value.lifecycle.pendingDraftId !== null)
      )
        fail(["lifecycle"], "A void original draft cannot be reopened");
      return;
    }
    if (
      value.status === "void" &&
      (value.lifecycle.currentEventId !== null || value.lifecycle.pendingDraftId !== null)
    )
      fail(["lifecycle"], "A voided effective receipt cannot be reopened");
    if (value.updatedAt !== content.finalizedAt || value.updatedBy !== content.finalizedBy)
      fail(["content"], "Frozen finalization actor and timestamp must match the content update");
    const snapshot = content.snapshot;
    if (value.revision > 1 && snapshot.snapshotVersion !== 3)
      fail(["content", "snapshot"], "Amendments require explicit v3 lot bindings");
    if (snapshot.snapshotVersion === 1) return;
    snapshot.items.forEach((item, index) => {
      if (
        item.receiptBasis.kind !== "ordinary" &&
        (item.receiptBasis.reviewedBy !== content.finalizedBy ||
          item.receiptBasis.reviewedAt !== content.finalizedAt)
      )
        fail(
          ["content", "snapshot", "items", index, "receiptBasis"],
          "Receipt review must match this finalization",
        );
    });
    if (snapshot.snapshotVersion !== 3) return;
    snapshot.items.forEach((item, index) => {
      if (item.lotBinding.kind !== "retained") return;
      if (
        value.revision === 1 ||
        !matches(value.lifecycle.previousRevisionId, item.lotBinding.previousEventId)
      )
        fail(
          ["content", "snapshot", "items", index, "lotBinding"],
          "Retained binding must reference the immediate predecessor",
        );
    });
  });

export const receivingOperationReceiptV2Schema = z
  .object({
    receiptVersion: z.literal(2),
    command: z.enum([
      "receiving.create",
      "receiving.save",
      "receiving.finalize",
      "receiving.amend",
      "receiving.void",
    ]),
    operationKey: z.uuid(),
    inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    eventId: z.uuid(),
    record: receivingLiveRecordSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!sameId(value.eventId, value.record.id))
      context.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "Receipt target must match its saved record",
      });
    const record = value.record;
    const valid =
      value.command === "receiving.create"
        ? record.status === "draft" && record.revision === 1
        : value.command === "receiving.save"
          ? record.status === "draft"
          : value.command === "receiving.amend"
            ? record.status === "draft" && record.revision > 1
            : value.command === "receiving.finalize"
              ? record.status === "finalized"
              : record.status === "void";
    if (!valid)
      context.addIssue({
        code: "custom",
        path: ["record"],
        message: "Acknowledged state must match the committed command",
      });
  });

// Never derive legacy acknowledgements from a live read or widen their original parsers.
export const receivingCommandResultSchema = z.union([
  receivingOperationReceiptV2Schema,
  receivingDraftRecordSchema,
  receivingFinalizedRecordSchema,
]);

const summarySchema = identitySchema.safeExtend({
  dateReceived: pinnedDraft.shape.dateReceived,
  locationId: pinnedDraft.shape.locationId,
  previousSourceLocationId: pinnedDraft.shape.previousSourceLocationId,
  lineCount: z.number().int().min(0).max(100),
  documentCount: z.number().int().min(0).max(100),
});
const page = {
  limit: z.number().int().min(1).max(100),
  offset: z.number().int().min(0).max(100000),
};
export const listReceivingLiveRecordsQuerySchema = listReceivingDraftsQuerySchema
  .extend({
    history: z.enum(["current", "all"]).default("current"),
    status: z.enum(["draft", "finalized", "amended", "void"]).optional(),
  })
  .strict();
export const receivingLiveRecordListSchema = z
  .object({ items: z.array(summarySchema).max(100), ...page })
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
      const rootId = item.lifecycle.rootId.toLowerCase();
      const first = roots.get(rootId);
      if (
        ids.has(id) ||
        (first !== undefined &&
          (first.eventNumber !== item.eventNumber ||
            first.timeZone !== item.timeZone ||
            first.lifecycle.lifecycleVersion !== item.lifecycle.lifecycleVersion ||
            first.lifecycle.currentEventId?.toLowerCase() !==
              item.lifecycle.currentEventId?.toLowerCase() ||
            first.lifecycle.pendingDraftId?.toLowerCase() !==
              item.lifecycle.pendingDraftId?.toLowerCase()))
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
export const receivingRevisionListQuerySchema = listReceivingDraftsQuerySchema
  .pick({ limit: true, offset: true })
  .strict();
export const receivingBasisQuerySchema = receivingRevisionListQuerySchema;
export const receivingRevisionListSchema = z
  .object({
    items: z.array(summarySchema).max(100),
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
    value.items.forEach((item, index) => {
      if (
        item.lifecycle.lifecycleVersion !== value.lifecycleVersion ||
        (first !== undefined &&
          (!sameId(first.lifecycle.rootId, item.lifecycle.rootId) ||
            first.eventNumber !== item.eventNumber ||
            first.timeZone !== item.timeZone ||
            first.lifecycle.currentEventId?.toLowerCase() !==
              item.lifecycle.currentEventId?.toLowerCase() ||
            first.lifecycle.pendingDraftId?.toLowerCase() !==
              item.lifecycle.pendingDraftId?.toLowerCase())) ||
        (index > 0 && item.revision <= (value.items[index - 1]?.revision ?? 0))
      )
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "History must contain ascending revisions of one root snapshot",
        });
    });
  });

const basisEntry = z
  .object({
    rootId: z.uuid(),
    eventId: z.uuid(),
    eventNumber: old.eventNumber,
    revision: version,
    lineNos: z
      .array(lineNumber)
      .min(1)
      .max(100)
      .refine((lines) =>
        lines.every((line, index) => index === 0 || line > (lines[index - 1] ?? 0)),
      ),
  })
  .strict();
/** Shape/count consistency only; the server must query complete tenant-scoped support. */
export const receivingBasisSchema = z
  .object({
    lotId: z.uuid(),
    basisVersion: version,
    state: z.enum(["present", "missing"]),
    supportCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    items: z.array(basisEntry).max(100),
    ...page,
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === "missing") !== (value.supportCount === 0) ||
      value.items.length !==
        Math.min(value.limit, Math.max(0, value.supportCount - value.offset)) ||
      value.hasMore !== value.offset + value.items.length < value.supportCount
    )
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Basis state and page must agree with the complete support count",
      });
    const roots = new Set<string>();
    const events = new Set<string>();
    let previous = "";
    value.items.forEach((item, index) => {
      const root = item.rootId.toLowerCase();
      const event = item.eventId.toLowerCase();
      const key = `${root}:${event}`;
      if (
        roots.has(root) ||
        events.has(event) ||
        (index > 0 && key <= previous) ||
        (item.revision === 1) !== (root === event)
      )
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message: "Basis must list unique current revisions in root/event order",
        });
      roots.add(root);
      events.add(event);
      previous = key;
    });
  });

export type ReceivingLiveRecord = z.infer<typeof receivingLiveRecordSchema>;
export type ReceivingLiveRecordList = z.infer<typeof receivingLiveRecordListSchema>;
export type ListReceivingLiveRecordsQuery = z.infer<typeof listReceivingLiveRecordsQuerySchema>;
export type ReceivingOperationReceiptV2 = z.infer<typeof receivingOperationReceiptV2Schema>;
export type ReceivingCommandResult = z.infer<typeof receivingCommandResultSchema>;
export type ReceivingRevisionList = z.infer<typeof receivingRevisionListSchema>;
export type ReceivingBasis = z.infer<typeof receivingBasisSchema>;
export type ReceivingRevisionListQuery = z.infer<typeof receivingRevisionListQuerySchema>;
export type ReceivingBasisQuery = z.infer<typeof receivingBasisQuerySchema>;
