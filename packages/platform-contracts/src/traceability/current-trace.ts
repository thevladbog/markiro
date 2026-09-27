import { UOM_CODES_V1 } from "@markiro/domain";
import { z } from "zod";
import { platformUuidSchema } from "../primitives.js";
import { traceabilityCivilDateSchema } from "./event-values.js";
import { provisionUsTraceabilityProfileSchema } from "./profile.js";

const boundedInt = (max: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(max));
const direction = z.enum(["backward", "forward", "both"]);
const eventType = z.enum(["receiving", "transformation", "shipping"]);
const revision = z.number().int().min(1);
const nonemptyDisplay = z.string().min(1).max(2000);
const nodeId = z.string().min(1);
const lineNo = z.number().int().min(1);
const quantity = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,17})(?:\.\d{1,3})?$/)
  .refine((value) => /[1-9]/.test(value), "Expected positive decimal quantity");
const unitOfMeasure = z.enum(UOM_CODES_V1);
const timeZone = provisionUsTraceabilityProfileSchema.shape.timeZone;

/** Query values are raw HTTP strings. Duplicate URL keys are rejected by the HTTP controller. */
export const usCurrentTraceQuerySchema = z
  .object({
    direction: direction.default("both"),
    maxDepth: boundedInt(20).default(16),
    maxNodes: boundedInt(500).pipe(z.number().int().min(1)).default(500),
  })
  .strict();

export const usTraceHistoryCursorSchema = z
  .object({ createdAt: z.iso.datetime(), eventId: platformUuidSchema })
  .strict();
const opaqueCursor = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(512);
export const usTraceHistoryQuerySchema = z
  .object({
    limit: boundedInt(100).pipe(z.number().int().min(1)).default(50),
    cursor: opaqueCursor.optional(),
  })
  .strict();

const lotNode = z
  .object({ id: nodeId, kind: z.literal("lot"), lotId: platformUuidSchema, tlc: nonemptyDisplay })
  .strict();
const locationNode = z
  .object({
    id: nodeId,
    kind: z.literal("location"),
    locationId: platformUuidSchema,
    display: nonemptyDisplay,
    displayEdgeId: nodeId,
  })
  .strict();
const transformationNode = z
  .object({
    id: nodeId,
    kind: z.literal("transformation"),
    eventId: platformUuidSchema,
    display: nonemptyDisplay,
  })
  .strict();
const materialNode = z
  .object({
    id: nodeId,
    kind: z.literal("material"),
    eventId: platformUuidSchema,
    lineNo,
    display: nonemptyDisplay,
  })
  .strict();
const node = z.discriminatedUnion("kind", [
  lotNode,
  locationNode,
  transformationNode,
  materialNode,
]);
const edge = z
  .object({
    id: nodeId,
    kind: z.enum(["receiving", "transformation_input", "transformation_output", "shipping"]),
    from: nodeId,
    to: nodeId,
    eventId: platformUuidSchema,
    eventNumber: nonemptyDisplay,
    revision,
    lineNo,
    eventDate: traceabilityCivilDateSchema,
    timeZone,
    quantity: quantity.optional(),
    unitOfMeasure: unitOfMeasure.optional(),
    locationDisplay: nonemptyDisplay.optional(),
  })
  .strict()
  .refine((value) => (value.quantity === undefined) === (value.unitOfMeasure === undefined), {
    message: "Quantity and unit of measure must appear together",
  })
  .refine(
    (value) =>
      (value.kind === "receiving" || value.kind === "shipping") ===
      (value.locationDisplay !== undefined),
    {
      message: "Receiving and Shipping lines must carry their frozen location display",
    },
  );
const currentEvent = z
  .object({
    id: platformUuidSchema,
    rootId: platformUuidSchema,
    type: eventType,
    eventNumber: nonemptyDisplay,
    revision,
    eventDate: traceabilityCivilDateSchema,
    timeZone,
  })
  .strict();
const completion = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("complete"),
      returnedNodes: z.number().int().min(1).max(500),
      returnedEdges: z.number().int().min(0).max(2000),
    })
    .strict(),
  z
    .object({
      state: z.literal("limited"),
      limit: z.enum(["depth", "nodes", "edges"]),
      returnedNodes: z.number().int().min(1).max(500),
      returnedEdges: z.number().int().min(0).max(2000),
    })
    .strict(),
]);

export const usCurrentTraceResultSchema = z
  .object({
    rootLotId: platformUuidSchema,
    direction,
    nodes: z.array(node).min(1).max(500),
    edges: z.array(edge).max(2000),
    currentEvents: z.array(currentEvent).max(2000),
    excludedSummary: z.object({ count: z.number().int().min(0) }).strict(),
    findings: z
      .array(z.object({ code: z.literal("origin_gap"), lotId: platformUuidSchema }).strict())
      .max(500),
    completion,
  })
  .strict()
  .superRefine((result, context) => {
    const ids = new Set(result.nodes.map((item) => item.id));
    const edgesById = new Map(result.edges.map((item) => [item.id, item]));
    const findingLots = new Set<string>();
    result.findings.forEach((finding, index) => {
      if (!ids.has(`lot:${finding.lotId}`) || findingLots.has(finding.lotId))
        context.addIssue({
          code: "custom",
          path: ["findings", index],
          message: "Origin gaps must reference distinct visible lots",
        });
      findingLots.add(finding.lotId);
    });
    result.nodes.forEach((item, index) => {
      if (item.kind === "location") {
        const source = edgesById.get(item.displayEdgeId);
        if (
          !source ||
          source.locationDisplay !== item.display ||
          !(
            (source.kind === "receiving" && source.from === item.id) ||
            (source.kind === "shipping" && source.to === item.id)
          )
        )
          context.addIssue({
            code: "custom",
            path: ["nodes", index, "displayEdgeId"],
            message: "Location display must match its frozen evidence edge",
          });
      }
      const expected =
        item.kind === "lot"
          ? `lot:${item.lotId}`
          : item.kind === "location"
            ? `location:${item.locationId}`
            : item.kind === "transformation"
              ? `transformation:${item.eventId}`
              : `material:${item.eventId}:${item.lineNo}`;
      if (item.id !== expected)
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "id"],
          message: "Node ID must match its source identity",
        });
    });
    if (ids.size !== result.nodes.length)
      context.addIssue({ code: "custom", path: ["nodes"], message: "Node IDs must be unique" });
    if (!ids.has(`lot:${result.rootLotId}`))
      context.addIssue({ code: "custom", path: ["nodes"], message: "Root lot node is required" });
    if (
      result.completion.returnedNodes !== result.nodes.length ||
      result.completion.returnedEdges !== result.edges.length
    )
      context.addIssue({
        code: "custom",
        path: ["completion"],
        message: "Returned counts must match evidence",
      });
    const edgeIds = new Set<string>();
    const eventsById = new Map(result.currentEvents.map((item) => [item.id, item]));
    result.edges.forEach((item, index) => {
      if (edgeIds.has(item.id))
        context.addIssue({
          code: "custom",
          path: ["edges", index, "id"],
          message: "Edge IDs must be unique",
        });
      edgeIds.add(item.id);
      if (!ids.has(item.from) || !ids.has(item.to))
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "Edge endpoints must be present",
        });
      const side =
        item.kind === "transformation_input"
          ? "input"
          : item.kind === "transformation_output"
            ? "output"
            : item.kind;
      if (item.id !== `${item.eventId}:${side}:${item.lineNo}`)
        context.addIssue({
          code: "custom",
          path: ["edges", index, "id"],
          message: "Edge ID must match its frozen line",
        });
      const event = eventsById.get(item.eventId);
      if (
        !event ||
        event.type !== (item.kind.startsWith("transformation_") ? "transformation" : item.kind) ||
        event.eventNumber !== item.eventNumber ||
        event.revision !== item.revision ||
        event.eventDate !== item.eventDate ||
        event.timeZone !== item.timeZone
      )
        context.addIssue({
          code: "custom",
          path: ["edges", index, "eventId"],
          message: "Edge must match a current event",
        });
      const validShape =
        (item.kind === "receiving" &&
          item.from.startsWith("location:") &&
          item.to.startsWith("lot:")) ||
        (item.kind === "transformation_input" &&
          (item.from.startsWith("lot:") || item.from.startsWith("material:")) &&
          item.to.startsWith("transformation:")) ||
        (item.kind === "transformation_output" &&
          item.from.startsWith("transformation:") &&
          item.to.startsWith("lot:")) ||
        (item.kind === "shipping" &&
          item.from.startsWith("lot:") &&
          item.to.startsWith("location:"));
      if (!validShape)
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "Evidence edge has invalid endpoint kinds",
        });
      if (
        ((item.kind === "transformation_input" || item.kind === "transformation_output") &&
          (item.kind === "transformation_input" ? item.to : item.from) !==
            `transformation:${item.eventId}`) ||
        (item.kind === "transformation_input" &&
          item.from.startsWith("material:") &&
          item.from !== `material:${item.eventId}:${item.lineNo}`)
      )
        context.addIssue({
          code: "custom",
          path: ["edges", index],
          message: "Transformation endpoints must match the frozen event and line",
        });
    });
  });

const historicalItem = z
  .object({
    eventId: platformUuidSchema,
    rootId: platformUuidSchema,
    type: eventType,
    eventNumber: nonemptyDisplay,
    revision,
    status: z.enum(["draft", "amended", "void"]),
    reason: nonemptyDisplay.nullable(),
    previousRevisionId: platformUuidSchema.nullable(),
    nextRevisionId: platformUuidSchema.nullable(),
    eventDate: traceabilityCivilDateSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const usTraceHistoryPageSchema = z
  .object({ items: z.array(historicalItem).max(100), nextCursor: opaqueCursor.nullable() })
  .strict();

export type UsCurrentTraceResult = z.infer<typeof usCurrentTraceResultSchema>;
export type UsTraceHistoryPage = z.infer<typeof usTraceHistoryPageSchema>;
