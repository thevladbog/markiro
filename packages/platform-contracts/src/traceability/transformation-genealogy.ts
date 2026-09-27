import { UOM_CODES_V1 } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { transformationFinalizationSnapshotV1Schema } from "./transformation-records.js";

const revisionIds = z
  .array(platformUuidSchema)
  .max(100)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
    message: "Duplicate pinned revision ID",
  });
const request = {
  startLotId: platformUuidSchema,
  direction: z.enum(["upstream", "downstream"]),
  maxDepth: z.number().int().min(0).max(20),
  maxNodes: z.number().int().min(1).max(500),
};

/** Tenant identity comes from the authorized service context, never this request. */
export const transformationGenealogyRequestSchema = z.discriminatedUnion("mode", [
  z.object({ ...request, mode: z.literal("current") }).strict(),
  z.object({ ...request, mode: z.literal("pinned"), pinnedRevisionIds: revisionIds }).strict(),
]);

const positiveQuantity = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,3})?$/)
  .refine((value) => /[1-9]/.test(value), "Expected positive decimal quantity");
const signedQuantity = z.string().regex(/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,3})?$/);
const unit = z.enum(UOM_CODES_V1);
const balanceValue = z
  .object({ side: z.enum(["input", "output"]), quantity: positiveQuantity, unitOfMeasure: unit })
  .strict();
const balance = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("arithmetic"),
      unitOfMeasure: unit,
      inputQuantity: positiveQuantity,
      outputQuantity: positiveQuantity,
      deltaQuantity: signedQuantity,
    })
    .strict(),
  z.object({ state: z.literal("unknown"), values: z.array(balanceValue) }).strict(),
]);
const lot = z.object({ id: platformUuidSchema, currentOrigin: z.boolean() }).strict();
const event = z
  .object({
    id: platformUuidSchema,
    rootId: platformUuidSchema,
    revision: z.number().int().min(1),
    status: z.enum(["finalized", "amended", "void"]),
    snapshot: transformationFinalizationSnapshotV1Schema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.snapshot === null
        ? value.status === "void"
        : value.id === value.snapshot.eventId && value.revision === value.snapshot.revision,
    {
      message: "Event provenance must match its frozen snapshot",
    },
  );
/** Edge quantities are deliberately absent: quantities belong to snapshot lines. */
const link = z
  .object({
    eventId: platformUuidSchema,
    inputLotId: platformUuidSchema,
    outputLotId: platformUuidSchema,
  })
  .strict();
const diagnostic = z
  .object({
    code: z.enum(["cycle", "limit", "origin_gap", "inconsistent_evidence"]),
    lotId: platformUuidSchema.optional(),
    eventId: platformUuidSchema.optional(),
  })
  .strict();

/** selectedRevisionIds lists only revisions actually included in events, in stable ID order. */
export const transformationGenealogyResultSchema = z
  .object({
    startLotId: platformUuidSchema,
    direction: z.enum(["upstream", "downstream"]),
    mode: z.enum(["current", "pinned"]),
    selectedRevisionIds: z.array(platformUuidSchema).max(500),
    lots: z.array(lot).max(500),
    events: z.array(event).max(500),
    links: z.array(link).max(2000),
    complete: z.boolean(),
    diagnostics: z.array(diagnostic),
    balance,
  })
  .strict()
  .superRefine((result, context) => {
    const add = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    if (result.lots.length + result.events.length > 500)
      add(["lots"], "Lot and event node cap exceeded");
    const sortedUnique = (ids: string[]) =>
      ids.length === new Set(ids.map((id) => id.toLowerCase())).size &&
      ids.every((id, index) => index === 0 || ids[index - 1]! < id);
    if (!sortedUnique(result.lots.map((item) => item.id)))
      add(["lots"], "Lots must be sorted and unique");
    const lotIds = new Set(result.lots.map((item) => item.id));
    if (!lotIds.has(result.startLotId)) add(["lots"], "Start lot must be present");
    if (!sortedUnique(result.events.map((item) => item.id)))
      add(["events"], "Events must be sorted and unique");
    const eventsById = new Map(result.events.map((item) => [item.id, item]));
    const included = result.events.map((item) => item.id);
    if (
      !sortedUnique(result.selectedRevisionIds) ||
      result.selectedRevisionIds.length !== included.length ||
      result.selectedRevisionIds.some((id, index) => id !== included[index])
    )
      add(["selectedRevisionIds"], "Selection must equal included revisions in ID order");
    const linkKeys = result.links.map(
      (item) => `${item.eventId}/${item.inputLotId}/${item.outputLotId}`,
    );
    if (!sortedUnique(linkKeys)) add(["links"], "Links must be sorted and unique");
    result.links.forEach((item, index) => {
      const selected = eventsById.get(item.eventId);
      if (!selected) add(["links", index, "eventId"], "Link event must be present");
      if (!lotIds.has(item.inputLotId))
        add(["links", index, "inputLotId"], "Link input lot must be present");
      if (!lotIds.has(item.outputLotId))
        add(["links", index, "outputLotId"], "Link output lot must be present");
      if (!selected) return;
      if (!selected.snapshot) {
        add(["links", index, "eventId"], "Snapshotless revision cannot have links");
        return;
      }
      if (
        !selected.snapshot.inputs.some(
          (line) => line.kind === "ftl_lot" && line.lotId === item.inputLotId,
        )
      )
        add(["links", index, "inputLotId"], "Link input must match a frozen FTL line");
      if (!selected.snapshot.outputs.some((line) => line.lotId === item.outputLotId))
        add(["links", index, "outputLotId"], "Link output must match a frozen output line");
    });
    if (result.complete && result.diagnostics.length > 0)
      add(["complete"], "A diagnosed result is incomplete");
    if (!result.complete && result.diagnostics.length === 0)
      add(["diagnostics"], "An incomplete result requires a diagnostic");
    if (
      result.events.every((item) => item.snapshot === null) &&
      (result.balance.state !== "unknown" || result.balance.values.length !== 0)
    )
      add(["balance"], "Balance without frozen lines must be unknown and empty");
  });

export type TransformationGenealogyRequest = z.infer<typeof transformationGenealogyRequestSchema>;
export type TransformationGenealogyResult = z.infer<typeof transformationGenealogyResultSchema>;
