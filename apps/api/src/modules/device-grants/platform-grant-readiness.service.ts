import { BadRequestException, Inject, Injectable, Optional } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type { PlatformPrincipal } from "@markiro/platform-contracts";
import {
  platformGrantReadinessListResponseSchema,
  platformGrantReadinessListQuerySchema,
  platformGrantReadinessPreviewResponseSchema,
  type GrantReadinessReason,
  type PlatformGrantReadinessListQuery,
  type PlatformGrantReadinessListResponse,
  type PlatformGrantReadinessPreviewRequest,
  type PlatformGrantReadinessPreviewResponse,
  type PlatformGrantReadinessRow,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  classifyGrantReadiness,
  readGrantReadinessFacts,
  type GrantReadinessFactCursor,
  type GrantReadinessFacts,
  type GrantReadinessSigningFacts,
  type GrantReadinessTargetPolicy,
} from "./grant-readiness-facts";
import { GRANT_CLOCK } from "./grant-issuer.service";
import { GRANT_SIGNING_CONFIGURATION, type GrantSigningConfiguration } from "./grant-keyset";
import { parseApprovedGrantPolicy } from "./grant-policy";

const cursorSchema = z
  .object({
    version: z.literal(1),
    asOf: z.iso.datetime({ offset: true }),
    binding: z.object({
      tenantId: z.string().optional(),
      deviceKind: z.enum(["station", "handheld", "kiosk"]).optional(),
      readiness: z.enum(["eligible", "blocked"]).optional(),
      policyId: z.uuid().optional(),
    }),
    last: z.tuple([z.string(), z.enum(["station", "handheld", "kiosk"]), z.uuid()]),
  })
  .strict();

type Cursor = z.infer<typeof cursorSchema>;
type Binding = Cursor["binding"];

@Injectable()
export class PlatformGrantReadinessService {
  private readonly signingFacts: GrantReadinessSigningFacts;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(GRANT_SIGNING_CONFIGURATION) signing: GrantSigningConfiguration | null,
    private readonly audit: PlatformAuditService,
    @Optional() @Inject(GRANT_CLOCK) private readonly clock: () => number = Date.now,
  ) {
    this.signingFacts = {
      configured: Boolean(signing && signing.keyset.keys.length > 0),
      keysetRevision: signing?.keyset.revision ?? null,
      retiredKids: new Set(signing?.keyset.retiredKids ?? []),
    };
  }

  async list(
    _principal: PlatformPrincipal,
    input: PlatformGrantReadinessListQuery,
  ): Promise<PlatformGrantReadinessListResponse> {
    const query = platformGrantReadinessListQuerySchema.parse(input);
    const binding = queryBinding(query);
    const cursor = query.cursor ? decodeCursor(query.cursor, binding) : null;
    const asOf = cursor ? new Date(cursor.asOf) : this.now();
    const result = await this.db.transaction(
      async (tx) => {
        const filters = {
          ...(query.tenantId ? { tenantId: query.tenantId } : {}),
          ...(query.deviceKind ? { deviceKind: query.deviceKind } : {}),
        };
        const page = await readFilteredRows(
          tx,
          asOf,
          filters,
          this.signingFacts,
          query,
          cursor ? factCursor(cursor.last) : undefined,
          query.limit + 1,
        );
        const aggregates = await readAggregates(tx, asOf, filters, this.signingFacts, query);
        const hasMore = page.length > query.limit;
        const items = page.slice(0, query.limit);
        return {
          asOf: asOf.toISOString(),
          items,
          aggregates,
          nextCursor:
            hasMore && items.length > 0 ? encodeCursor(asOf, binding, items.at(-1)!) : null,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    return platformGrantReadinessListResponseSchema.parse(result);
  }

  async preview(
    principal: PlatformPrincipal,
    input: PlatformGrantReadinessPreviewRequest,
  ): Promise<PlatformGrantReadinessPreviewResponse> {
    const asOf = this.now();
    const snapshot = await this.db.transaction(
      async (tx) => {
        const targetPolicy = await loadTargetPolicy(tx, input.policyId);
        if (!targetPolicy) throw invalidPreview("GRANT_READINESS_POLICY_NOT_APPROVED");
        const facts = await readGrantReadinessFacts(
          tx,
          asOf,
          { deviceIds: input.deviceIds },
          this.signingFacts,
        );
        const found = new Set(facts.map((fact) => fact.deviceId));
        if (input.deviceIds.some((deviceId) => !found.has(deviceId)))
          throw invalidPreview("GRANT_READINESS_DEVICE_NOT_FOUND");
        const rows = facts.map((fact) => toRow(fact, targetPolicy, asOf));
        const aggregates = aggregate(rows);
        const canonicalFacts = rows.map((row) => ({
          tenantId: row.tenantId,
          deviceId: row.deviceId,
          deviceKind: row.deviceKind,
          credentialEpoch: row.credentialEpoch,
          assignmentId: row.assignmentId,
          configurationId: row.configuration?.id ?? null,
          clientReportId: row.clientReport?.id ?? null,
          keysetRevision: row.signing.keysetRevision,
          eligibility: row.eligibility,
        }));
        const previewDigest = entitlementDigest({
          protocol: "offline-grants-readiness-preview-v1",
          policyId: targetPolicy.id,
          policyRevision: targetPolicy.revision,
          mode: input.mode,
          deviceIds: [...input.deviceIds].sort(),
          facts: canonicalFacts,
          asOf: asOf.toISOString(),
        });
        return { targetPolicy, rows, aggregates, previewDigest };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    await this.db.transaction((tx) =>
      this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "offline_grant.readiness.previewed",
        outcome: "success",
        tenantId: null,
        targetType: "offline_grant_policy",
        targetId: snapshot.targetPolicy.id,
        reason: null,
        before: null,
        after: {
          policyRevision: snapshot.targetPolicy.revision,
          mode: input.mode,
          asOf: asOf.toISOString(),
          previewDigest: snapshot.previewDigest,
          eligible: snapshot.aggregates.eligible,
          blocked: snapshot.aggregates.blocked,
          reasons: snapshot.aggregates.reasons,
        },
        requestId: input.requestId,
      }),
    );
    return platformGrantReadinessPreviewResponseSchema.parse({
      requestId: input.requestId,
      policyId: snapshot.targetPolicy.id,
      policyRevision: snapshot.targetPolicy.revision,
      mode: input.mode,
      asOf: asOf.toISOString(),
      previewDigest: snapshot.previewDigest,
      items: snapshot.rows,
      aggregates: snapshot.aggregates,
    });
  }

  private now(): Date {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid readiness clock");
    return new Date(value);
  }
}

async function loadTargetPolicy(
  tx: SubscriptionTransaction,
  policyId: string,
): Promise<GrantReadinessTargetPolicy | null> {
  const [row] = await tx
    .select()
    .from(schema.entitlementLifecyclePolicies)
    .where(eq(schema.entitlementLifecyclePolicies.id, policyId))
    .limit(1);
  const policy = parseApprovedGrantPolicy(row);
  return policy ? { id: policy.id, revision: policy.revision, approved: true } : null;
}

function toRow(
  facts: GrantReadinessFacts,
  targetPolicy: GrantReadinessTargetPolicy,
  asOf: Date,
): PlatformGrantReadinessRow {
  const eligibility = classifyGrantReadiness(facts, targetPolicy, asOf);
  return {
    tenantId: facts.tenantId,
    tenantName: facts.tenantName,
    deviceId: facts.deviceId,
    deviceKind: facts.deviceKind,
    deviceName: facts.deviceName,
    credentialEpoch: facts.credentialEpoch,
    credentialActive: facts.credentialActive,
    revokedAt: isoOrNull(facts.revokedAt),
    assignmentId: facts.assignmentId,
    lastSeenAt: isoOrNull(facts.lastSeenAt),
    currentPolicy: facts.currentPolicy,
    signing: {
      configured: facts.signingConfigured,
      keysetRevision: facts.currentKeysetRevision,
    },
    configuration: facts.configuration
      ? {
          id: facts.configuration.id,
          mode: facts.configuration.mode,
          policyRevision: facts.configuration.policyRevision,
        }
      : null,
    clientReport: facts.clientReport
      ? {
          id: facts.clientReport.id,
          receivedAt: facts.clientReport.receivedAt.toISOString(),
          clientBuild: facts.clientReport.clientBuild,
          storageRevision: facts.clientReport.storageRevision,
          credentialEpoch: facts.clientReport.credentialEpoch,
          mode: facts.clientReport.mode,
          policyRevision: facts.clientReport.policyRevision,
          keysetRevision: facts.clientReport.keysetRevision,
          verifiedGrantId: facts.clientReport.verifiedGrantId,
          matchesCurrentConfiguration: facts.clientReport.matchesCurrentConfiguration,
          verifiedGrantMatched: facts.clientReport.verifiedGrantMatched,
        }
      : null,
    verifiedGrant: facts.verifiedGrant
      ? {
          id: facts.verifiedGrant.id,
          issuedAt: facts.verifiedGrant.issuedAt.toISOString(),
          kid: facts.verifiedGrant.kid,
          retired: facts.retiredKids.has(facts.verifiedGrant.kid),
        }
      : null,
    evidence: {
      acceptedCount: facts.evidence.acceptedCount,
      lastAcceptedAt: isoOrNull(facts.evidence.lastAcceptedAt),
    },
    eligibility,
  };
}

function aggregate(rows: readonly PlatformGrantReadinessRow[]) {
  const reasons: Partial<Record<GrantReadinessReason, number>> = {};
  let eligible = 0;
  for (const row of rows) {
    if (row.eligibility.status === "eligible") eligible += 1;
    for (const reason of row.eligibility.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { total: rows.length, eligible, blocked: rows.length - eligible, reasons };
}

function queryBinding(query: PlatformGrantReadinessListQuery): Binding {
  return {
    ...(query.tenantId ? { tenantId: query.tenantId } : {}),
    ...(query.deviceKind ? { deviceKind: query.deviceKind } : {}),
    ...(query.readiness ? { readiness: query.readiness } : {}),
    ...(query.policyId ? { policyId: query.policyId } : {}),
  };
}

function decodeCursor(raw: string, expectedBinding: Binding): Cursor {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error();
    const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    if (entitlementDigest(cursor.binding) !== entitlementDigest(expectedBinding)) throw new Error();
    return cursor;
  } catch {
    throw new BadRequestException({ code: "GRANT_READINESS_INVALID_CURSOR" });
  }
}

function encodeCursor(asOf: Date, binding: Binding, row: PlatformGrantReadinessRow): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      asOf: asOf.toISOString(),
      binding,
      last: [row.tenantId, row.deviceKind, row.deviceId],
    } satisfies Cursor),
  ).toString("base64url");
}

function missingTargetPolicy(): GrantReadinessTargetPolicy {
  return { id: "00000000-0000-0000-0000-000000000000", revision: "missing", approved: false };
}

type ReadinessTx = SubscriptionTransaction;

async function readFilteredRows(
  tx: ReadinessTx,
  asOf: Date,
  filters: Parameters<typeof readGrantReadinessFacts>[2],
  signing: GrantReadinessSigningFacts,
  query: PlatformGrantReadinessListQuery,
  after: GrantReadinessFactCursor | undefined,
  limit: number,
): Promise<PlatformGrantReadinessRow[]> {
  const rows: PlatformGrantReadinessRow[] = [];
  let boundary = after;
  while (rows.length < limit) {
    const batchLimit = limit - rows.length;
    const facts = await readGrantReadinessFacts(tx, asOf, filters, signing, {
      ...(boundary ? { after: boundary } : {}),
      limit: batchLimit,
    });
    if (facts.length === 0) break;
    boundary = factCursorFromFacts(facts.at(-1)!);
    rows.push(
      ...facts
        .filter((fact) => !query.policyId || fact.currentPolicy?.id === query.policyId)
        .map((fact) => toRow(fact, fact.currentPolicy ?? missingTargetPolicy(), asOf))
        .filter((row) => !query.readiness || row.eligibility.status === query.readiness),
    );
    if (facts.length < batchLimit) break;
  }
  return rows.slice(0, limit);
}

async function readAggregates(
  tx: ReadinessTx,
  asOf: Date,
  filters: Parameters<typeof readGrantReadinessFacts>[2],
  signing: GrantReadinessSigningFacts,
  query: PlatformGrantReadinessListQuery,
) {
  const result = { total: 0, eligible: 0, blocked: 0, reasons: {} } as ReturnType<typeof aggregate>;
  let boundary: GrantReadinessFactCursor | undefined;
  for (;;) {
    const facts = await readGrantReadinessFacts(tx, asOf, filters, signing, {
      ...(boundary ? { after: boundary } : {}),
      limit: 500,
    });
    if (facts.length === 0) break;
    boundary = factCursorFromFacts(facts.at(-1)!);
    const batch = aggregate(
      facts
        .filter((fact) => !query.policyId || fact.currentPolicy?.id === query.policyId)
        .map((fact) => toRow(fact, fact.currentPolicy ?? missingTargetPolicy(), asOf))
        .filter((row) => !query.readiness || row.eligibility.status === query.readiness),
    );
    result.total += batch.total;
    result.eligible += batch.eligible;
    result.blocked += batch.blocked;
    for (const [reason, count] of Object.entries(batch.reasons) as Array<
      [GrantReadinessReason, number]
    >)
      result.reasons[reason] = (result.reasons[reason] ?? 0) + count;
    if (facts.length < 500) break;
  }
  return result;
}

function factCursor(last: Cursor["last"]): GrantReadinessFactCursor {
  return { tenantId: last[0], deviceKind: last[1], deviceId: last[2] };
}

function factCursorFromFacts(fact: GrantReadinessFacts): GrantReadinessFactCursor {
  return { tenantId: fact.tenantId, deviceKind: fact.deviceKind, deviceId: fact.deviceId };
}

function invalidPreview(code: string) {
  return new BadRequestException({ code });
}

function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
