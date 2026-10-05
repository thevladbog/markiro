import type { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import {
  platformUuidSchema,
  usExportInputV1Schema,
  usTraceRequestCreateBodySchema,
  usTraceRequestPrepareBodySchema,
  usTraceRequestScopeV1Schema,
  type ExportSourceRecord,
} from "@markiro/platform-contracts";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import {
  stableStringify,
  US_REQUEST_SNAPSHOT_LIMIT,
  type UsRequestSnapshot,
} from "./us-request-snapshot";
import { usRequestTenantOriginSchema } from "./us-request-tenant-origin";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().min(1);
const editable = usTraceRequestCreateBodySchema.shape;
const metadata = usExportInputV1Schema.shape.metadata.shape;
const selectionSchema = z
  .object({
    scope: usTraceRequestScopeV1Schema,
    seeds: z.array(z.object({ kind: z.enum(["lot", "event"]), id: platformUuidSchema }).strict()),
    records: z
      .array(
        z
          .object({
            eventId: platformUuidSchema,
            revision: positive,
            reason: z.enum(["match", "dependency"]),
            rootEventId: platformUuidSchema,
          })
          .strict(),
      )
      .max(500),
    lotIds: z.array(platformUuidSchema),
    relations: z.array(
      z
        .object({
          eventId: platformUuidSchema,
          lotId: platformUuidSchema,
          lineNo: positive,
          role: z.enum(["receiving", "input", "output", "shipping"]),
        })
        .strict(),
    ),
  })
  .strict();
const snapshotV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    tenantId: usExportInputV1Schema.shape.tenantId,
    request: z
      .object({
        id: platformUuidSchema,
        revision: positive,
        requestNumber: editable.requestNumber,
        requesterName: editable.requesterName,
        requesterOrganization: editable.requesterOrganization,
        requesterContact: editable.requesterContact,
        receivedAt: editable.receivedAt,
        dueAt: z.iso.datetime(),
        alternateDeadlineReason: editable.alternateDeadlineReason.unwrap(),
      })
      .strict(),
    selection: selectionSchema,
    sources: z.array(usExportInputV1Schema.shape.events.element).max(500),
    matches: z.array(
      z
        .object({
          kind: z.enum(["lot", "event"]),
          id: platformUuidSchema,
          fields: z.array(z.string()),
        })
        .strict(),
    ),
    genealogy: z.array(
      z
        .object({
          eventId: platformUuidSchema,
          inputLotId: platformUuidSchema,
          outputLotId: platformUuidSchema,
        })
        .strict(),
    ),
    lots: z.array(z.record(z.string(), z.json())),
    lifecycle: z.array(z.record(z.string(), z.json())),
    findings: usExportInputV1Schema.shape.findings,
    plan: z.object({ id: platformUuidSchema, pdfSha256: digest }).strict().nullable(),
    profile: metadata.profile,
    timeZone: metadata.timeZone,
    baselineId: metadata.baselineId,
    registryId: metadata.registryId,
    registryVersion: metadata.registryVersion,
    registryHash: metadata.registryHash,
    build: metadata.build,
  })
  .strict();
const snapshotV2Schema = snapshotV1Schema
  .extend({ schemaVersion: z.literal(2), tenantOrigin: usRequestTenantOriginSchema })
  .refine(
    (value) =>
      value.tenantOrigin.result !== "trusted_synthetic" ||
      value.tenantOrigin.trustedSeed.seedId === value.tenantId,
  );
const frozenV1ObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    selectionKind: z.enum(["empty", "events"]),
    mode: usTraceRequestPrepareBodySchema.shape.mode,
    generatedAt: z.iso.datetime(),
    preparedBy: z.string().min(1),
    validationSnapshot: snapshotV1Schema,
    exportInput: usExportInputV1Schema.nullable(),
    warningAcknowledgement: z
      .object({
        digest,
        reason: z.string().min(3).max(2000),
        actorId: z.string().min(1),
        acknowledgedAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const frozenV1Schema = frozenV1ObjectSchema.refine(
  (value) => (value.selectionKind === "empty") === (value.exportInput === null),
);
const frozenV2Schema = frozenV1ObjectSchema
  .extend({ schemaVersion: z.literal(2), validationSnapshot: snapshotV2Schema })
  .refine((value) => (value.selectionKind === "empty") === (value.exportInput === null));
const frozenSchema = z.union([frozenV1Schema, frozenV2Schema]);

export type UsTraceExportRunRow = typeof schema.traceExportRuns.$inferSelect;
export type UsRequestFrozenRunV1 = z.infer<typeof frozenV1Schema>;
export type UsRequestFrozenRunV2 = z.infer<typeof frozenV2Schema>;
export type UsRequestFrozenRun = UsRequestFrozenRunV1 | UsRequestFrozenRunV2;

/** Shape parsing for new Prepare envelopes; this does not verify saved row evidence. */
export function parseUsRequestFrozenRun(value: unknown): UsRequestFrozenRun | null {
  const parsed = frozenSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Pure compatibility gate for package inputs; this grants no authorization. */
export function requireUsRequestPackageEvidence(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
): UsRequestFrozenRunV2 {
  const frozen = verifyUsRequestRunEvidence(run, expectedTenantId);
  if (frozen.schemaVersion !== 2)
    throw new ConflictException({ code: "us_request_package_refreeze_required" });
  return frozen;
}

export function selectsEvents(snapshot: UsRequestSnapshot): boolean {
  const scope = snapshot.selection.scope;
  return Boolean(
    scope.eventDateFrom || scope.eventDateTo || scope.locationIds || scope.documentNumber,
  );
}

/** Re-traverse the captured graph after removing excluded revisions and their edges. */
export function currentChain(snapshot: UsRequestSnapshot): readonly ExportSourceRecord[] {
  const current = snapshot.sources.filter((source) => source.lifecycle === "current_finalized");
  const currentIds = new Set(current.map((source) => source.eventId));
  const eventLots = new Map<string, Set<string>>();
  const lotEvents = new Map<string, Set<string>>();
  for (const relation of snapshot.selection.relations) {
    if (!currentIds.has(relation.eventId)) continue;
    const lots = eventLots.get(relation.eventId) ?? new Set<string>();
    lots.add(relation.lotId);
    eventLots.set(relation.eventId, lots);
    const events = lotEvents.get(relation.lotId) ?? new Set<string>();
    events.add(relation.eventId);
    lotEvents.set(relation.lotId, events);
  }
  const roots = new Map(
    snapshot.selection.records.map((record) => [record.eventId, record.rootEventId]),
  );
  const currentByRoot = new Map(
    snapshot.selection.records
      .filter((record) => currentIds.has(record.eventId))
      .map((record) => [record.rootEventId, record.eventId]),
  );
  const pendingLots = snapshot.selection.seeds
    .filter((seed) => seed.kind === "lot")
    .map((seed) => seed.id);
  const pendingEvents: string[] = [];
  if (selectsEvents(snapshot))
    for (const seed of snapshot.selection.seeds) {
      if (seed.kind !== "event") continue;
      const root = roots.get(seed.id),
        id = root ? currentByRoot.get(root) : undefined;
      if (id) pendingEvents.push(id);
    }
  const visitedLots = new Set<string>(),
    visitedEvents = new Set<string>();
  while (pendingLots.length || pendingEvents.length) {
    const lot = pendingLots.pop();
    if (lot && !visitedLots.has(lot)) {
      visitedLots.add(lot);
      pendingEvents.push(...(lotEvents.get(lot) ?? []));
    }
    const event = pendingEvents.pop();
    if (event && !visitedEvents.has(event)) {
      visitedEvents.add(event);
      pendingLots.push(...(eventLots.get(event) ?? []));
    }
  }
  return current.filter((source) => visitedEvents.has(source.eventId));
}

/** Verify only immutable saved evidence. Current request/source/build and worker
 * status may have advanced since the original command was accepted. */
export function verifyUsRequestRunEvidence(
  run: UsTraceExportRunRow,
  expectedTenantId: string,
): UsRequestFrozenRun {
  const invalid = () => new ServiceUnavailableException({ code: "us_request_run_stored_invalid" });
  try {
    const saved = stableStringify(run.inputSnapshot);
    if (Buffer.byteLength(saved, "utf8") > US_REQUEST_SNAPSHOT_LIMIT) throw invalid();
    const parsed = frozenSchema.safeParse(run.inputSnapshot);
    if (!parsed.success) throw invalid();
    // Entry schemas normalize UUIDs/text/quantities. A saved envelope must
    // already be canonical: parsing must never conceal modified stored bytes.
    if (stableStringify(parsed.data) !== saved) throw invalid();
    const frozen = parsed.data;
    const snapshot = frozen.validationSnapshot;
    const input = frozen.exportInput;
    if (
      run.tenantId !== expectedTenantId ||
      frozen.preparedBy !== run.createdBy ||
      frozen.mode !== run.mode ||
      snapshot.tenantId !== run.tenantId ||
      snapshot.request.id !== run.requestId ||
      frozen.generatedAt !== run.startedAt.toISOString() ||
      (snapshot.plan?.id ?? null) !== run.planVersionId ||
      (snapshot.plan?.pdfSha256 ?? null) !== run.planPdfSha256 ||
      snapshot.registryVersion !== run.registryVersion ||
      snapshot.registryHash !== run.registryHash ||
      canonicalExportDigest(snapshot) !== run.scopedContentDigest ||
      canonicalExportDigest({ schemaVersion: 1, requestId: run.requestId, mode: run.mode }) !==
        run.commandDigest ||
      (frozen.warningAcknowledgement !== null &&
        frozen.warningAcknowledgement.digest !== run.scopedContentDigest)
    )
      throw invalid();
    const records = snapshot.selection.records
      .map((record) => `${record.eventId}:${record.revision}`)
      .sort();
    const sources = snapshot.sources.map((source) => `${source.eventId}:${source.revision}`).sort();
    if (
      new Set(sources).size !== sources.length ||
      stableStringify(records) !== stableStringify(sources)
    )
      throw invalid();
    if (input === null) {
      if (
        run.inputDigest !== null ||
        snapshot.sources.length !== 0 ||
        run.mode !== "available_records_incomplete"
      )
        throw invalid();
      return frozen;
    }
    const expectedEvents = run.mode === "export_ready" ? currentChain(snapshot) : snapshot.sources;
    const inputMetadata = input.metadata;
    if (
      input.tenantId !== run.tenantId ||
      input.mode !==
        (run.mode === "export_ready" ? "export_ready_candidate" : "available_records_incomplete") ||
      inputMetadata.generatedAt !== frozen.generatedAt ||
      inputMetadata.scopeLabel !== snapshot.request.requestNumber ||
      inputMetadata.profile !== snapshot.profile ||
      inputMetadata.timeZone !== snapshot.timeZone ||
      inputMetadata.baselineId !== snapshot.baselineId ||
      inputMetadata.registryId !== snapshot.registryId ||
      inputMetadata.registryVersion !== snapshot.registryVersion ||
      inputMetadata.registryHash !== snapshot.registryHash ||
      stableStringify(inputMetadata.build) !== stableStringify(snapshot.build) ||
      canonicalExportDigest({ events: input.events }) !==
        canonicalExportDigest({ events: expectedEvents }) ||
      canonicalExportDigest(input) !== run.inputDigest
    )
      throw invalid();
    return frozen;
  } catch {
    // Never expose corrupt requester/source payloads or parser issues in errors.
    throw invalid();
  }
}
