import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";

export const INVENTORY_EVENT_BATCH_SIZE = 100;
export const INVENTORY_PROGRESS_PAGE_SIZE = 200;
export const INVENTORY_EVENT_CLAIM_OUTCOME_SIZE = 10_000;
export const INVENTORY_EVENT_BATCH_CLAIM_OUTCOME_SIZE = 10_000;
export const INVENTORY_PROGRESS_CURSOR_PATTERN =
  "^[1-9][0-9]*:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const uuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const civilDateSchema = z.iso.date();
const instantSchema = z.iso.datetime({ offset: true });

export const inventoryEventSchema = z.strictObject({
  eventId: uuidSchema,
  deviceSequence: z.number().int().positive().safe(),
  operatorId: uuidSchema,
  scannedAt: instantSchema,
  kind: z.enum(["item", "known_box", "old_box"]),
  normalizedIdentity: z.string().min(1).max(1024),
  codeHash: hashSchema.nullable(),
  canonicalRaw: z.string().min(1).max(2048).nullable(),
  activeProductionDate: civilDateSchema.nullable(),
  localVerdict: z.enum(["expected", "protected", "known-ineligible", "unknown", "duplicate"]),
});

export type InventoryEvent = z.infer<typeof inventoryEventSchema>;

export const inventoryEventBatchPayloadSchema = z
  .strictObject({
    snapshotId: uuidSchema,
    snapshotRevision: z.literal(1),
    sequenceCeiling: z.number().int().positive().safe(),
    pendingEventCount: z.number().int().nonnegative().safe(),
    openBoxCount: z.number().int().nonnegative().safe(),
    events: z.array(inventoryEventSchema).min(1).max(INVENTORY_EVENT_BATCH_SIZE),
  })
  .superRefine((value, context) => {
    const eventIds = new Set<string>();
    const sequences = new Set<number>();
    let prior = 0;
    for (const [index, event] of value.events.entries()) {
      if (eventIds.has(event.eventId)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "eventId"],
          message: "duplicate event id",
        });
      }
      if (sequences.has(event.deviceSequence)) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "deviceSequence"],
          message: "duplicate device sequence",
        });
      }
      if (event.deviceSequence <= prior) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "deviceSequence"],
          message: "events are not ordered",
        });
      }
      eventIds.add(event.eventId);
      sequences.add(event.deviceSequence);
      prior = event.deviceSequence;
    }
    if (value.events.at(-1)?.deviceSequence !== value.sequenceCeiling) {
      context.addIssue({
        code: "custom",
        path: ["sequenceCeiling"],
        message: "sequence ceiling mismatch",
      });
    }
  });

export type InventoryEventBatchPayload = z.infer<typeof inventoryEventBatchPayloadSchema>;

export const inventoryEventBatchSchema = inventoryEventBatchPayloadSchema
  .extend({
    batchId: z.string().min(1).max(128),
    payloadDigest: hashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const { batchId: ignoredBatchId, payloadDigest, ...payload } = value;
    void ignoredBatchId;
    if (inventoryEventBatchDigest(payload) !== payloadDigest) {
      context.addIssue({
        code: "custom",
        path: ["payloadDigest"],
        message: "payload digest mismatch",
      });
    }
  });

export type InventoryEventBatch = z.infer<typeof inventoryEventBatchSchema>;

export interface InventoryClaimWinner {
  codeHash: string;
  eventId: string;
  deviceId: string;
  scannedAt: string;
}

export const inventoryClaimWinnerSchema = z.strictObject({
  codeHash: hashSchema,
  eventId: uuidSchema,
  deviceId: uuidSchema,
  scannedAt: instantSchema,
});

export const inventoryEventClaimOutcomeSchema = z
  .strictObject({
    codeHash: hashSchema,
    status: z.enum(["claimed", "duplicate"]),
    winner: inventoryClaimWinnerSchema,
  })
  .superRefine((value, context) => {
    if (value.winner.codeHash !== value.codeHash) {
      context.addIssue({
        code: "custom",
        path: ["winner", "codeHash"],
        message: "winner mismatch",
      });
    }
  });

export type InventoryEventClaimOutcome = z.infer<typeof inventoryEventClaimOutcomeSchema>;

export const INVENTORY_EVENT_OUTCOMES = [
  "applied",
  "replay",
  "duplicate",
  "rejected",
  "quarantined",
] as const;

export const inventoryEventOutcomeSchema = z
  .strictObject({
    eventId: uuidSchema,
    status: z.enum(INVENTORY_EVENT_OUTCOMES),
    reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
    claimedCount: z.number().int().nonnegative().safe(),
    conflictCount: z.number().int().nonnegative().safe(),
    claims: z.array(inventoryEventClaimOutcomeSchema).max(INVENTORY_EVENT_CLAIM_OUTCOME_SIZE),
  })
  .superRefine((value, context) => {
    const hashes = new Set<string>();
    for (const [index, claim] of value.claims.entries()) {
      if (hashes.has(claim.codeHash)) {
        context.addIssue({
          code: "custom",
          path: ["claims", index, "codeHash"],
          message: "duplicate claim",
        });
      }
      hashes.add(claim.codeHash);
      if (claim.status === "claimed" && claim.winner.eventId !== value.eventId) {
        context.addIssue({
          code: "custom",
          path: ["claims", index, "winner", "eventId"],
          message: "claimed winner mismatch",
        });
      }
      if (claim.status === "duplicate" && claim.winner.eventId === value.eventId) {
        context.addIssue({
          code: "custom",
          path: ["claims", index, "winner", "eventId"],
          message: "duplicate winner mismatch",
        });
      }
    }
    if (
      value.claimedCount !== value.claims.filter((claim) => claim.status === "claimed").length ||
      value.conflictCount !== value.claims.filter((claim) => claim.status === "duplicate").length
    ) {
      context.addIssue({ code: "custom", path: ["claims"], message: "claim counts mismatch" });
    }
    const carriesClaims = value.claims.length > 0;
    if (
      (value.status === "duplicate" &&
        (value.claimedCount !== 0 ||
          value.conflictCount === 0 ||
          value.reasonCode !== "CLAIM_LOST")) ||
      (value.status === "applied" &&
        ((carriesClaims && value.claimedCount === 0) || value.reasonCode !== "CLAIM_APPLIED")) ||
      (value.status === "replay" && value.reasonCode !== "BATCH_REPLAY") ||
      ((value.status === "rejected" || value.status === "quarantined") &&
        (value.claimedCount !== 0 || value.conflictCount !== 0 || carriesClaims))
    ) {
      context.addIssue({ code: "custom", path: ["status"], message: "outcome contradiction" });
    }
  });

export type InventoryEventOutcome = z.infer<typeof inventoryEventOutcomeSchema>;

export const inventoryEventBatchResponseSchema = z
  .strictObject({
    inventoryId: uuidSchema,
    snapshotId: uuidSchema,
    snapshotRevision: z.literal(1),
    batchId: z.string().min(1).max(128),
    payloadDigest: hashSchema,
    sequenceCeiling: z.number().int().positive().safe(),
    resultRevision: z.number().int().nonnegative().safe(),
    outcomes: z.array(inventoryEventOutcomeSchema).min(1).max(INVENTORY_EVENT_BATCH_SIZE),
  })
  .superRefine((value, context) => {
    const claimCount = value.outcomes.reduce((total, outcome) => total + outcome.claims.length, 0);
    if (claimCount > INVENTORY_EVENT_BATCH_CLAIM_OUTCOME_SIZE) {
      context.addIssue({ code: "custom", path: ["outcomes"], message: "too many claims" });
    }
  });

export type InventoryEventBatchResponse = z.infer<typeof inventoryEventBatchResponseSchema>;

export const inventoryProgressCursorSchema = z
  .string()
  .regex(new RegExp(INVENTORY_PROGRESS_CURSOR_PATTERN));

export const inventoryProgressChangeSchema = z.strictObject({
  id: uuidSchema,
  revision: z.number().int().positive().safe(),
  kind: z.enum(["claim", "correction"]),
  codeHash: hashSchema,
  classification: z.enum(["expected", "protected", "ineligible", "unknown", "voided"]),
  observedProductionDate: civilDateSchema.nullable(),
  winner: inventoryClaimWinnerSchema.nullable(),
  correctedAt: instantSchema,
});

export type InventoryProgressChange = z.infer<typeof inventoryProgressChangeSchema>;

export const inventoryProgressPageSchema = z.strictObject({
  inventoryId: uuidSchema,
  snapshotId: uuidSchema,
  snapshotRevision: z.literal(1),
  cursor: inventoryProgressCursorSchema.nullable(),
  resultRevision: z.number().int().nonnegative().safe(),
  items: z.array(inventoryProgressChangeSchema).max(INVENTORY_PROGRESS_PAGE_SIZE),
  nextCursor: inventoryProgressCursorSchema.nullable(),
});

export type InventoryProgressPage = z.infer<typeof inventoryProgressPageSchema>;

function canonicalPayload(payload: InventoryEventBatchPayload): Record<string, unknown> {
  return {
    snapshotId: payload.snapshotId,
    snapshotRevision: payload.snapshotRevision,
    sequenceCeiling: payload.sequenceCeiling,
    pendingEventCount: payload.pendingEventCount,
    openBoxCount: payload.openBoxCount,
    events: payload.events.map((event) => ({
      eventId: event.eventId,
      deviceSequence: event.deviceSequence,
      operatorId: event.operatorId,
      scannedAt: event.scannedAt,
      kind: event.kind,
      normalizedIdentity: event.normalizedIdentity,
      codeHash: event.codeHash,
      canonicalRaw: event.canonicalRaw,
      activeProductionDate: event.activeProductionDate,
      localVerdict: event.localVerdict,
    })),
  };
}

export function inventoryEventBatchDigest(value: unknown): string {
  const parsed = inventoryEventBatchPayloadSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid inventory event batch payload");
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonicalPayload(parsed.data)))));
}

export function parseInventoryEventBatch(value: unknown): InventoryEventBatch {
  const parsed = inventoryEventBatchSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid inventory event batch");
  return parsed.data;
}

export function parseInventoryEventBatchResponse(
  value: unknown,
  request: InventoryEventBatch,
  expectedInventoryId: string,
  expectedDeviceId?: string,
): InventoryEventBatchResponse {
  const parsed = inventoryEventBatchResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid inventory event batch response");
  const response = parsed.data;
  if (
    response.inventoryId !== expectedInventoryId ||
    response.snapshotId !== request.snapshotId ||
    response.snapshotRevision !== request.snapshotRevision ||
    response.batchId !== request.batchId ||
    response.payloadDigest !== request.payloadDigest ||
    response.sequenceCeiling !== request.sequenceCeiling ||
    response.outcomes.length !== request.events.length
  ) {
    throw new Error("Invalid inventory event batch response");
  }
  const requested = new Set(request.events.map((event) => event.eventId));
  const accounted = new Set<string>();
  for (const outcome of response.outcomes) {
    if (!requested.has(outcome.eventId) || accounted.has(outcome.eventId)) {
      throw new Error("Invalid inventory event batch response");
    }
    const requestEvent = request.events.find((event) => event.eventId === outcome.eventId);
    if (!requestEvent) throw new Error("Invalid inventory event batch response");
    const claimBearing =
      outcome.status === "applied" || outcome.status === "replay" || outcome.status === "duplicate";
    if (
      claimBearing &&
      requestEvent.kind === "item" &&
      (outcome.claims.length !== 1 || outcome.claims[0]?.codeHash !== requestEvent.codeHash)
    ) {
      throw new Error("Invalid inventory event batch response");
    }
    if (claimBearing && requestEvent.kind === "old_box" && outcome.claims.length !== 0) {
      throw new Error("Invalid inventory event batch response");
    }
    if (
      outcome.status === "applied" &&
      outcome.claimedCount === 0 &&
      requestEvent.kind !== "old_box"
    ) {
      throw new Error("Invalid inventory event batch response");
    }
    for (const claim of outcome.claims) {
      if (
        claim.status === "claimed" &&
        (claim.winner.scannedAt !== requestEvent.scannedAt ||
          (expectedDeviceId !== undefined && claim.winner.deviceId !== expectedDeviceId))
      ) {
        throw new Error("Invalid inventory event batch response");
      }
    }
    accounted.add(outcome.eventId);
  }
  if (accounted.size !== requested.size) throw new Error("Invalid inventory event batch response");
  return response;
}

export interface ExpectedInventoryProgressPage {
  inventoryId: string;
  snapshotId: string;
  cursor: string | null;
  minimumResultRevision: number;
}

export function parseInventoryProgressPage(
  value: unknown,
  expected: ExpectedInventoryProgressPage,
): InventoryProgressPage {
  const parsed = inventoryProgressPageSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid inventory progress page");
  if (
    parsed.data.inventoryId !== expected.inventoryId ||
    parsed.data.snapshotId !== expected.snapshotId ||
    parsed.data.cursor !== expected.cursor ||
    parsed.data.resultRevision < expected.minimumResultRevision
  ) {
    throw new Error("Invalid inventory progress page");
  }
  let previous = parsed.data.cursor
    ? {
        revision: Number(parsed.data.cursor.split(":", 1)[0]),
        id: parsed.data.cursor.slice(parsed.data.cursor.indexOf(":") + 1),
      }
    : null;
  for (const item of parsed.data.items) {
    if (
      item.revision > parsed.data.resultRevision ||
      (item.winner !== null && item.winner.codeHash !== item.codeHash) ||
      (previous !== null &&
        (item.revision < previous.revision ||
          (item.revision === previous.revision && item.id <= previous.id)))
    ) {
      throw new Error("Invalid inventory progress page");
    }
    previous = { revision: item.revision, id: item.id };
  }
  const expectedNext =
    parsed.data.items.length === 0 || previous === null
      ? null
      : `${previous.revision}:${previous.id}`;
  if (parsed.data.nextCursor !== expectedNext) {
    throw new Error("Invalid inventory progress page");
  }
  return parsed.data;
}
