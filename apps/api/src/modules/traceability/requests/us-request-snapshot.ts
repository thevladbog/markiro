import { schema } from "@markiro/db";
import {
  buildUsExportWorkbook,
  canonicalExportDigest,
  resolveUsRequestDeadline,
  traceExportRegistryHash,
} from "@markiro/domain";
import {
  usExportBuildIdentitySchema,
  usExportInputV1Schema,
  usTraceRequestCreateBodySchema,
  type ExportFinding,
  type ExportSourceRecord,
  type UsExportBuildIdentity,
} from "@markiro/platform-contracts";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { readUsExportSourcesInTransaction } from "../export/source-reader";
import { parseUsPlanPublishedRow } from "../plans/us-plan-published";
import { selectUsRequestScope, type UsRequestSelection } from "./us-request-selection";
import {
  usRequestTenantOriginSchema,
  type UsRequestTenantOrigin,
} from "./us-request-tenant-origin";

export type UsRequestRow = typeof schema.traceRequests.$inferSelect;
export const US_REQUEST_SNAPSHOT_LIMIT = 16 * 1024 * 1024;
const unavailable = () => new ServiceUnavailableException({ code: "us_request_snapshot_invalid" });

/** Strict lossless JSON; callers explicitly order sets, while saved arrays retain order. */
export function stableStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || ancestors.has(item)) throw new TypeError("non_json_snapshot");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) throw new TypeError("non_json_snapshot");
        return `[${Array.from(item, serialize).join(",")}]`;
      }
      if (
        Object.getPrototypeOf(item) !== Object.prototype ||
        Reflect.ownKeys(item).length !== Object.keys(item).length
      )
        throw new TypeError("non_json_snapshot");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      return `{${Object.keys(descriptors)
        .sort()
        .map((key) => {
          const descriptor = descriptors[key];
          if (!descriptor || !("value" in descriptor)) throw new TypeError("non_json_snapshot");
          return `${JSON.stringify(key)}:${serialize(descriptor.value)}`;
        })
        .join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return serialize(value);
}
const ordered = <T>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => {
    const left = stableStringify(a),
      right = stableStringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });

export type UsRequestSnapshotV1 = {
  schemaVersion: 1;
  tenantId: string;
  request: {
    id: string;
    revision: number;
    requestNumber: string;
    requesterName: string;
    requesterOrganization: string | null;
    requesterContact: string | null;
    receivedAt: string;
    dueAt: string;
    alternateDeadlineReason: string | null;
  };
  selection: UsRequestSelection;
  sources: readonly ExportSourceRecord[];
  matches: readonly { kind: "lot" | "event"; id: string; fields: readonly string[] }[];
  genealogy: readonly { eventId: string; inputLotId: string; outputLotId: string }[];
  lots: readonly Record<string, unknown>[];
  lifecycle: readonly Record<string, unknown>[];
  findings: readonly ExportFinding[];
  plan: { id: string; pdfSha256: string } | null;
  profile: "US_FSMA204_PROCESSOR";
  timeZone: string;
  baselineId: string;
  registryId: "fda_sortable_xlsx";
  registryVersion: 1;
  registryHash: string;
  build: UsExportBuildIdentity;
};
export type UsRequestSnapshotV2 = Omit<UsRequestSnapshotV1, "schemaVersion"> & {
  schemaVersion: 2;
  tenantOrigin: UsRequestTenantOrigin;
};
export type UsRequestSnapshot = UsRequestSnapshotV1 | UsRequestSnapshotV2;

/** Caller owns authorization, row locking and the repeatable-read transaction. */
export async function captureUsRequestScope(
  tx: UsMasterDataTransaction,
  tenantId: string,
  actorUserId: string,
  requestRow: UsRequestRow,
  build: UsExportBuildIdentity,
  tenantOrigin: UsRequestTenantOrigin,
): Promise<{ snapshot: UsRequestSnapshotV2; digest: string; byteSize: number }> {
  if (requestRow.tenantId !== tenantId) throw unavailable();
  const origin = usRequestTenantOriginSchema.safeParse(tenantOrigin);
  if (
    !origin.success ||
    (origin.data.result === "trusted_synthetic" && origin.data.trustedSeed.seedId !== tenantId)
  )
    throw unavailable();
  if (requestRow.status !== "open" || requestRow.scope === null)
    throw new ConflictException({ code: "us_request_scope_required" });
  const editable = usTraceRequestCreateBodySchema.safeParse({
    requestNumber: requestRow.requestNumber,
    requesterName: requestRow.requesterName,
    requesterOrganization: requestRow.requesterOrganization,
    requesterContact: requestRow.requesterContact,
    receivedAt: requestRow.receivedAt.toISOString(),
    dueAt: requestRow.dueAt.toISOString(),
    alternateDeadlineReason: requestRow.alternateDeadlineReason,
    scope: requestRow.scope,
  });
  const stamp = usExportBuildIdentitySchema.safeParse(build);
  if (
    !editable.success ||
    !editable.data.scope ||
    !stamp.success ||
    requestRow.closedAt !== null ||
    !Number.isSafeInteger(requestRow.revision) ||
    requestRow.revision < 1
  )
    throw unavailable();
  try {
    resolveUsRequestDeadline(
      editable.data.receivedAt,
      editable.data.dueAt,
      editable.data.alternateDeadlineReason,
    );
  } catch {
    throw unavailable();
  }
  // PostgreSQL JSON renders timestamptz using the session zone. Pin its encoding
  // without truncating persisted microseconds through JavaScript Date.
  await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);
  const selected = await selectUsRequestScope(tx, tenantId, editable.data.scope);
  const selection: UsRequestSelection = {
    ...selected,
    seeds: ordered(selected.seeds),
    records: ordered(selected.records),
    lotIds: [...selected.lotIds].sort(),
    relations: ordered(selected.relations),
  };
  const sources = selection.records.length
    ? ordered(
        await readUsExportSourcesInTransaction(
          tx,
          tenantId,
          actorUserId,
          selection.records.map(({ eventId, revision }) => ({ eventId, revision })),
          "available_records_incomplete",
        ),
      )
    : [];
  const [profile] = await tx
    .select({
      code: schema.traceabilityProfiles.code,
      baselineId: schema.traceabilityProfiles.baselineVersion,
      timeZone: schema.orgProfiles.timeZone,
    })
    .from(schema.traceabilityProfiles)
    .innerJoin(
      schema.orgProfiles,
      eq(schema.orgProfiles.tenantId, schema.traceabilityProfiles.tenantId),
    )
    .where(eq(schema.traceabilityProfiles.tenantId, tenantId));
  if (
    !profile ||
    profile.code !== "US_FSMA204_PROCESSOR" ||
    !profile.baselineId ||
    !profile.timeZone
  )
    throw unavailable();
  // SQL JSON keeps timestamp precision; decimal values are explicitly retained as text.
  const facts = await tx.execute<{ fact: Record<string, unknown> }>(sql`
    SELECT jsonb_build_object('lot',to_jsonb(l),'product',to_jsonb(p) || jsonb_build_object('unit_price',p.unit_price::text),'coverage',
      CASE WHEN pp.product_id IS NULL THEN NULL ELSE to_jsonb(pp) || jsonb_build_object('packaging_size_value',pp.packaging_size_value::text) END,
      'sourceLocation',CASE WHEN sl.id IS NULL THEN NULL ELSE to_jsonb(sl) || jsonb_build_object('latitude',sl.latitude::text,'longitude',sl.longitude::text) END,
      'referenceLocation',CASE WHEN rl.id IS NULL THEN NULL ELSE to_jsonb(rl) || jsonb_build_object('latitude',rl.latitude::text,'longitude',rl.longitude::text) END) AS fact
    FROM traceability_lots l JOIN products p ON p.tenant_id=${tenantId} AND p.id=l.product_id
    LEFT JOIN product_traceability_profiles pp ON pp.tenant_id=${tenantId} AND pp.product_id=p.id
    LEFT JOIN traceability_locations sl ON sl.tenant_id=${tenantId} AND sl.id=l.source_location_id
    LEFT JOIN traceability_locations rl ON rl.tenant_id=${tenantId} AND rl.id=l.source_reference_location_id
    WHERE l.tenant_id=${tenantId} AND l.id=ANY(${sql.param([...selection.lotIds])}::uuid[])
      AND (l.source_location_id IS NULL OR sl.id IS NOT NULL) AND (l.source_reference_location_id IS NULL OR rl.id IS NOT NULL)`);
  if (facts.rows.length !== selection.lotIds.length) throw unavailable();
  const genealogy = await tx.execute<{
    eventId: string;
    inputLotId: string;
    outputLotId: string;
  }>(sql`
    SELECT g.event_id AS "eventId",g.input_lot_id AS "inputLotId",g.output_lot_id AS "outputLotId"
    FROM lot_genealogy_edges g WHERE g.tenant_id=${tenantId}
      AND g.event_id=ANY(${sql.param(selection.records.map((record) => record.eventId))}::uuid[])`);
  // Edges corroborate complete input/output bindings; they never allocate quantity.
  const expectedEdges = sources.flatMap((source) =>
    source.type === "transformation" && source.payload.kind === "frozen"
      ? source.payload.snapshot.inputs.flatMap((input) =>
          input.kind === "ftl_lot"
            ? source.payload.kind === "frozen"
              ? source.payload.snapshot.outputs.map((output) => ({
                  eventId: source.eventId,
                  inputLotId: input.lotId,
                  outputLotId: output.lotId,
                }))
              : []
            : [],
        )
      : [],
  );
  const edgeKey = (edge: { eventId: string; inputLotId: string; outputLotId: string }) =>
    `${edge.eventId}:${edge.inputLotId}:${edge.outputLotId}`;
  const expectedKeys = new Set(expectedEdges.map(edgeKey));
  if (
    genealogy.rows.length !== expectedKeys.size ||
    genealogy.rows.some(
      (edge) =>
        !expectedKeys.has(edgeKey(edge)) ||
        !selection.lotIds.includes(edge.inputLotId) ||
        !selection.lotIds.includes(edge.outputLotId),
    )
  )
    throw unavailable();
  const lifecycle = await tx.execute<{ fact: Record<string, unknown> }>(sql`
    SELECT jsonb_build_object('event',to_jsonb(e)-'finalization_snapshot','root',CASE e.type
      WHEN 'receiving' THEN (SELECT to_jsonb(r) FROM receiving_event_roots r WHERE r.tenant_id=${tenantId} AND r.id=e.root_event_id)
      WHEN 'transformation' THEN (SELECT to_jsonb(r) FROM transformation_event_roots r WHERE r.tenant_id=${tenantId} AND r.id=e.root_event_id)
      WHEN 'shipping' THEN (SELECT to_jsonb(r) FROM shipping_event_roots r WHERE r.tenant_id=${tenantId} AND r.id=e.root_event_id) END) AS fact
    FROM traceability_events e WHERE e.tenant_id=${tenantId} AND e.id=ANY(${sql.param(selection.records.map((record) => record.eventId))}::uuid[])`);
  if (
    lifecycle.rows.length !== selection.records.length ||
    lifecycle.rows.some((row) => row.fact.root === null)
  )
    throw unavailable();
  const [planRow] = await tx
    .select()
    .from(schema.traceabilityPlanVersions)
    .where(
      and(
        eq(schema.traceabilityPlanVersions.tenantId, tenantId),
        eq(schema.traceabilityPlanVersions.status, "effective"),
      ),
    )
    .limit(1);
  const published = planRow ? parseUsPlanPublishedRow(planRow) : null;
  const findings: ExportFinding[] = [];
  const finding = (code: string, message: string): ExportFinding => ({
    code,
    severity: "error",
    sourceRecord: `request:${requestRow.id}`,
    message,
  });
  if (!sources.length)
    findings.push(
      finding("no_matches", "No matching event revisions are available for this scope."),
    );
  if (!published)
    findings.push(finding("plan_absent", "No effective traceability Plan is available."));
  const snapshot: UsRequestSnapshotV2 = {
    schemaVersion: 2,
    tenantOrigin: origin.data,
    tenantId,
    request: {
      id: requestRow.id,
      revision: requestRow.revision,
      requestNumber: editable.data.requestNumber,
      requesterName: editable.data.requesterName,
      requesterOrganization: editable.data.requesterOrganization,
      requesterContact: editable.data.requesterContact,
      receivedAt: editable.data.receivedAt,
      dueAt: requestRow.dueAt.toISOString(),
      alternateDeadlineReason: requestRow.alternateDeadlineReason,
    },
    selection,
    sources,
    matches: selection.seeds.map((seed) => ({
      ...seed,
      fields: Object.keys(selection.scope).sort(),
    })),
    genealogy: ordered(genealogy.rows),
    lots: ordered(facts.rows.map((row) => row.fact)),
    lifecycle: ordered(lifecycle.rows.map((row) => row.fact)),
    findings,
    plan: published ? { id: published.id, pdfSha256: published.artifact.sha256 } : null,
    profile: "US_FSMA204_PROCESSOR",
    timeZone: profile.timeZone,
    baselineId: profile.baselineId,
    registryId: "fda_sortable_xlsx",
    registryVersion: 1,
    registryHash: traceExportRegistryHash(),
    build: stamp.data,
  };
  if (sources.length) {
    const mode = "available_records_incomplete";
    // Pure US-07 model evaluation; the fixed instant never enters the captured envelope.
    const input = usExportInputV1Schema.parse({
      schemaVersion: 1,
      tenantId,
      mode,
      events: sources,
      findings,
      metadata: {
        mode,
        profile: snapshot.profile,
        scopeLabel: requestRow.requestNumber,
        timeZone: snapshot.timeZone,
        generatedAt: "2000-01-01T00:00:00.000Z",
        baselineId: snapshot.baselineId,
        registryId: snapshot.registryId,
        registryVersion: snapshot.registryVersion,
        registryHash: snapshot.registryHash,
        build: snapshot.build,
      },
    });
    const model = buildUsExportWorkbook(input);
    snapshot.findings = model.findings;
    if (model.failure)
      snapshot.findings = [
        ...snapshot.findings,
        finding(
          "workbook_unrepresentable",
          "The selected records exceed workbook representation limits.",
        ),
      ];
  }
  snapshot.findings = ordered(snapshot.findings);
  if (Buffer.byteLength(stableStringify(snapshot), "utf8") > US_REQUEST_SNAPSHOT_LIMIT)
    snapshot.findings = ordered([
      ...snapshot.findings,
      finding("snapshot_limit", "The immutable request snapshot exceeds 16 MiB."),
    ]);
  return {
    snapshot,
    digest: canonicalExportDigest(snapshot),
    byteSize: Buffer.byteLength(stableStringify(snapshot), "utf8"),
  };
}
