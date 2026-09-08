import { z } from "zod";
import { receivingReadinessIssueSchema } from "./receiving-readiness.js";

const version = z.number().int().min(1).max(2147483647);
const identityFields = [
  "previousLineNo",
  "lotId",
  "productId",
  "tlc",
  "source",
  "lotLinkMode",
  "receiptHandling",
] as const;

const identityLine = z
  .object({
    lineNo: z.number().int().min(1).max(100),
    fields: z
      .array(z.enum(identityFields))
      .min(1)
      .max(identityFields.length)
      .refine((fields) =>
        fields.every(
          (field, index) =>
            index === 0 ||
            identityFields.indexOf(field) > identityFields.indexOf(fields[index - 1] ?? field),
        ),
      ),
  })
  .strict();

const downstreamEvent = z
  .object({
    eventId: z.uuid(),
    eventNumber: z
      .string()
      .min(1)
      .max(128)
      .refine(
        (value) => value.trim().length > 0 && !value.includes("\u0000") && !/\p{Cs}/u.test(value),
      ),
    revision: version,
    kind: z.enum(["transformation", "shipping"]),
  })
  .strict();

/** Strict wire shapes only. Authorization, tenant scope and dependency completeness are server checks. */
export const receivingLifecycleErrorSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.enum([
        "receiving_draft_conflict",
        "receiving_operation_conflict",
        "receiving_already_finalized",
        "receiving_readiness_changed",
        "receiving_lot_conflict",
      ]),
    })
    .strict(),
  z
    .object({
      code: z.literal("receiving_lifecycle_conflict"),
      rootId: z.uuid(),
      lifecycleVersion: version,
      currentEventId: z.uuid().nullable(),
      pendingDraftId: z.uuid().nullable(),
    })
    .strict()
    .refine(
      (value) =>
        value.currentEventId === null ||
        value.pendingDraftId === null ||
        value.currentEventId.toLowerCase() !== value.pendingDraftId.toLowerCase(),
      "Current and pending revisions must be distinct",
    ),
  z
    .object({
      code: z.literal("receiving_pending_amendment"),
      pendingDraftId: z.uuid(),
    })
    .strict(),
  z
    .object({
      code: z.literal("lot_identity_locked"),
      lines: z
        .array(identityLine)
        .min(1)
        .max(100)
        .refine((lines) =>
          lines.every(
            (line, index) => index === 0 || line.lineNo > (lines[index - 1]?.lineNo ?? 0),
          ),
        ),
    })
    .strict(),
  z
    .object({
      code: z.literal("event_incomplete"),
      issues: z.array(receivingReadinessIssueSchema).max(5000),
    })
    .strict(),
  // Reserved contract, not an enabled downstream dependency adapter. Ordering
  // here validates a unique display list, never the actual dependency graph.
  z
    .object({
      code: z.literal("receiving_downstream_dependencies"),
      blockingEvents: z
        .array(downstreamEvent)
        .min(1)
        .max(100)
        .refine((events) =>
          events.every(
            (event, index) =>
              index === 0 ||
              event.eventId.toLowerCase() > (events[index - 1]?.eventId.toLowerCase() ?? ""),
          ),
        ),
      correctionOrder: z.array(z.uuid()).min(1).max(100),
      hasMore: z.boolean(),
    })
    .strict()
    .refine((value) => {
      const ids = new Set(value.blockingEvents.map((event) => event.eventId.toLowerCase()));
      const order = value.correctionOrder.map((id) => id.toLowerCase());
      return (
        order.length === ids.size &&
        new Set(order).size === ids.size &&
        order.every((id) => ids.has(id))
      );
    }, "Correction order must name each displayed blocking revision exactly once"),
]);

export type ReceivingLifecycleError = z.infer<typeof receivingLifecycleErrorSchema>;
export type ReceivingIdentityLockedLine = z.infer<typeof identityLine>;
