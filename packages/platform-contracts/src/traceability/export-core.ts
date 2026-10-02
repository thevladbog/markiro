import { z } from "zod";
import { platformTenantIdSchema, platformUuidSchema } from "../primitives.js";
import { provisionUsTraceabilityProfileSchema } from "./profile.js";
import { receivingDraftSchema } from "./receiving.js";
import { receivingAmendmentDraftSchema } from "./receiving-lifecycle.js";
import { receivingFinalizationSnapshotV1Schema } from "./receiving-finalization-v1.js";
import { receivingFinalizationSnapshotV2Schema } from "./receiving-finalization-v2.js";
import { receivingFinalizationSnapshotV3Schema } from "./receiving-finalization-v3.js";
import { transformationDraftSchema } from "./transformation-draft.js";
import { transformationFinalizationSnapshotV1Schema } from "./transformation-records.js";
import { shippingDraftSchema } from "./shipping-draft.js";
import { shippingFinalizationSnapshotV1Schema } from "./shipping-http.js";

const nonempty = z.string().refine((value) => value.trim().length > 0);
const mode = z.enum(["export_ready_candidate", "available_records_incomplete"]);
const revision = z.number().int().min(1);
const pin = z.object({ eventId: platformUuidSchema, revision }).strict();

/** US-00 identity supplied at build time; the export core never consults runtime Git. */
export const usExportBuildIdentitySchema = z
  .object({ apiVersion: nonempty, gitSha: z.string().regex(/^[0-9a-f]{40}$/), dirty: z.boolean() })
  .strict();

const metadata = z
  .object({
    mode,
    profile: z.literal("US_FSMA204_PROCESSOR"),
    scopeLabel: nonempty,
    timeZone: provisionUsTraceabilityProfileSchema.shape.timeZone,
    generatedAt: z.iso.datetime({ offset: true }),
    baselineId: nonempty,
    registryId: z.literal("fda_sortable_xlsx"),
    registryVersion: z.literal(1),
    registryHash: z.string().regex(/^[0-9a-f]{64}$/),
    build: usExportBuildIdentitySchema,
  })
  .strict();

const finding = z
  .object({
    code: nonempty,
    severity: z.enum(["error", "warning", "info"]),
    sourceRecord: nonempty,
    eventId: platformUuidSchema.optional(),
    revision: revision.optional(),
    lineNo: z.number().int().min(1).optional(),
    fieldKey: nonempty.optional(),
    message: nonempty,
  })
  .strict();

const envelope = {
  ...pin.shape,
  timeZone: provisionUsTraceabilityProfileSchema.shape.timeZone,
  lifecycle: z.enum(["current_finalized", "historical_finalized", "draft", "void"]),
};
const record = z
  .discriminatedUnion("type", [
    z
      .object({
        ...envelope,
        type: z.literal("receiving"),
        payload: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("frozen"),
              snapshot: z.union([
                receivingFinalizationSnapshotV1Schema,
                receivingFinalizationSnapshotV2Schema,
                receivingFinalizationSnapshotV3Schema,
              ]),
            })
            .strict(),
          z
            .object({
              kind: z.literal("saved_draft"),
              draft: z.union([receivingDraftSchema, receivingAmendmentDraftSchema]),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal("transformation"),
        payload: z.discriminatedUnion("kind", [
          z
            .object({
              kind: z.literal("frozen"),
              snapshot: transformationFinalizationSnapshotV1Schema,
            })
            .strict(),
          z.object({ kind: z.literal("saved_draft"), draft: transformationDraftSchema }).strict(),
        ]),
      })
      .strict(),
    z
      .object({
        ...envelope,
        type: z.literal("shipping"),
        payload: z.discriminatedUnion("kind", [
          z
            .object({ kind: z.literal("frozen"), snapshot: shippingFinalizationSnapshotV1Schema })
            .strict(),
          z.object({ kind: z.literal("saved_draft"), draft: shippingDraftSchema }).strict(),
        ]),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.type === "receiving" && value.payload.kind === "saved_draft") {
      const expectedDraft =
        value.revision === 1 ? receivingDraftSchema : receivingAmendmentDraftSchema;
      const parsed = expectedDraft.safeParse(value.payload.draft);
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          context.addIssue({ ...issue, path: ["payload", "draft", ...issue.path] });
    }
    const finalized =
      value.lifecycle === "current_finalized" || value.lifecycle === "historical_finalized";
    if (
      (finalized && value.payload.kind !== "frozen") ||
      (value.lifecycle === "draft" && value.payload.kind !== "saved_draft")
    )
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Payload must match the captured lifecycle",
      });
    // Receiving v1-v3 have no event identity fields: the server-owned reader binds them.
    if (value.type !== "receiving" && value.payload.kind === "frozen") {
      const snapshot = value.payload.snapshot;
      if (snapshot.eventId.toLowerCase() !== value.eventId || snapshot.revision !== value.revision)
        context.addIssue({
          code: "custom",
          path: ["payload", "snapshot"],
          message: "Frozen identity must match the event pin",
        });
      if (snapshot.timeZone !== value.timeZone)
        context.addIssue({
          code: "custom",
          path: ["payload", "snapshot", "timeZone"],
          message: "Frozen timezone must match the captured event timezone",
        });
    }
  });

/** Serializable captured values only; parsing neither authorizes nor declares request readiness. */
export const usExportInputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    mode,
    tenantId: platformTenantIdSchema,
    events: z.array(record).min(1),
    findings: z.array(finding),
    metadata,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode !== value.metadata.mode)
      context.addIssue({
        code: "custom",
        path: ["metadata", "mode"],
        message: "Metadata mode must match the input mode",
      });
    const identities = new Set<string>();
    value.events.forEach((event, index) => {
      const identity = `${event.eventId}:${event.revision}`;
      if (identities.has(identity))
        context.addIssue({
          code: "custom",
          path: ["events", index],
          message: "Duplicate event pin",
        });
      identities.add(identity);
      if (value.mode === "export_ready_candidate" && event.lifecycle !== "current_finalized")
        context.addIssue({
          code: "custom",
          path: ["events", index, "lifecycle"],
          message: "Candidate export requires current finalized records",
        });
    });
  });

export type ExportMode = z.infer<typeof mode>;
export type EventPin = z.infer<typeof pin>;
export type ExportFinding = z.infer<typeof finding>;
export type ExportMetadataV1 = z.infer<typeof metadata>;
export type ExportSourceRecord = z.infer<typeof record>;
export type ExportInputV1 = z.infer<typeof usExportInputV1Schema>;
export type UsExportBuildIdentity = z.infer<typeof usExportBuildIdentitySchema>;
