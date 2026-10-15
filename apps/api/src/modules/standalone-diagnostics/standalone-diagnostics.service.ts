import { randomUUID } from "node:crypto";
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  PayloadTooLargeException,
  UnprocessableEntityException,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  STANDALONE_DIAGNOSTICS_MAX_TEXT_CHARS,
  standaloneDiagnosticDetailSchema,
  standaloneDiagnosticsHistorySchema,
  standaloneDiagnosticsIngestResponseSchema,
  standaloneDiagnosticsOverviewSchema,
  standaloneDiagnosticsStatisticsSchema,
  standaloneSupportPayloadSchema,
  standaloneUsageTotalsSchema,
  type PlatformPrincipal,
  type StandaloneDiagnosticDetail,
  type StandaloneDiagnosticsHistory,
  type StandaloneDiagnosticsHistoryQuery,
  type StandaloneDiagnosticsIngestRequest,
  type StandaloneDiagnosticsIngestResponse,
  type StandaloneDiagnosticsOverview,
  type StandaloneDiagnosticsStatistics,
  type StandaloneDiagnosticsStatisticsQuery,
  type StandaloneSupportPayload,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { requireStandaloneLicenseActor } from "../standalone-licenses/standalone-license-authority";
import { standaloneTransaction } from "../standalone-licenses/standalone-license-transaction";
import { STANDALONE_SUPPORT_KEYS } from "./standalone-support-keys";
import { openSupportBlob, type SupportBlobFailure, type SupportPrivateKey } from "./support-blob";
import { parseSupportPayload } from "./support-payload";
import {
  decodeHistoryCursor,
  diagnosticSummary,
  encodeHistoryCursor,
  isOlderVersion,
  retentionCutoff,
  sumUsageMonths,
  type DiagnosticRow,
} from "./standalone-diagnostics-views";

export const STANDALONE_DIAGNOSTICS_CLOCK = Symbol("STANDALONE_DIAGNOSTICS_CLOCK");
export const STANDALONE_LATEST_BUILD = Symbol("STANDALONE_LATEST_BUILD");

/**
 * Where the newest PUBLISHED standalone build comes from (owner decision В5). Nothing in the cloud
 * publishes one yet — the owner signs update packages by hand — so the default knows none and
 * the overview carries `latestPublishedVersion: null` and no «outdated» verdict.
 */
export interface StandaloneLatestBuildSource {
  latestPublishedVersion(): Promise<string | null>;
}
export const noPublishedStandaloneBuild: StandaloneLatestBuildSource = {
  latestPublishedVersion: () => Promise.resolve(null),
};

const READ_CAPABILITIES = ["tenants.read"] as const;
const PURGE_BATCH = 500;
const REASON_CODE = {
  text_too_large: ["standalone_diagnostics_text_too_large", 413],
  no_token: ["standalone_diagnostics_no_token", 400],
  token_malformed: ["standalone_diagnostics_token_malformed", 400],
  token_too_large: ["standalone_diagnostics_token_too_large", 413],
  unknown_key: ["standalone_diagnostics_unknown_key", 422],
  undecryptable: ["standalone_diagnostics_undecryptable", 422],
  payload_too_large: ["standalone_diagnostics_payload_too_large", 413],
  payload_invalid: ["standalone_diagnostics_payload_invalid", 422],
  generated_in_future: ["standalone_diagnostics_generated_in_future", 422],
  host_other_tenant: ["standalone_diagnostics_host_other_tenant", 409],
  host_unbound: ["standalone_diagnostics_host_unbound", 409],
  token_conflict: ["standalone_diagnostics_token_conflict", 409],
} as const;
type Rejection = keyof typeof REASON_CODE;

interface Actor {
  id: string;
  role: "platform_admin" | "support" | "accountant";
}
type Outcome =
  | { kind: "done"; response: StandaloneDiagnosticsIngestResponse }
  | { kind: "rejected"; reason: Rejection; actor: Actor; after: Record<string, unknown> };

function refusalError(reason: Rejection): HttpException {
  const [code, status] = REASON_CODE[reason];
  const body = { code };
  if (status === 413) return new PayloadTooLargeException(body);
  if (status === 422) return new UnprocessableEntityException(body);
  if (status === 400) return new BadRequestException(body);
  return new ConflictException(body);
}

const blobReason = (reason: SupportBlobFailure): Rejection => reason;

@Injectable()
export class StandaloneDiagnosticsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_SUPPORT_KEYS) private readonly keys: readonly SupportPrivateKey[] | null,
    @Inject(STANDALONE_DIAGNOSTICS_CLOCK) private readonly now: () => Date,
    @Inject(STANDALONE_LATEST_BUILD) private readonly latest: StandaloneLatestBuildSource,
  ) {}

  /** Opens, validates, binds and stores one pasted support text (spec 3.5). */
  async ingest(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneDiagnosticsIngestRequest,
  ): Promise<StandaloneDiagnosticsIngestResponse> {
    const outcome = await standaloneTransaction(this.db, (tx) =>
      this.process(tx, principal, tenantId, body),
    );
    if (outcome.kind === "done") return outcome.response;
    // A refusal is audited in its own transaction: rolling the work back must not erase the trace.
    await this.db.transaction(async (tx) => {
      await this.audit.record(tx, {
        actorPlatformUserId: outcome.actor.id,
        actorRole: outcome.actor.role,
        action: "standalone.diagnostics.ingest",
        outcome: "rejected",
        tenantId,
        targetType: "standalone_support_diagnostic",
        targetId: null,
        reason: outcome.reason,
        requestId: null,
        before: null,
        after: outcome.after,
      });
    });
    throw refusalError(outcome.reason);
  }

  private async process(
    tx: SubscriptionTransaction,
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneDiagnosticsIngestRequest,
  ): Promise<Outcome> {
    const { user } = await requireStandaloneLicenseActor(tx, principal, tenantId, true);
    const actor: Actor = { id: user.id, role: user.role };
    if (this.keys === null)
      throw new ConflictException({ code: "standalone_diagnostics_not_configured" });
    const textBytes = Buffer.byteLength(body.text, "utf8");
    const reject = (reason: Rejection, extra: Record<string, unknown> = {}): Outcome => ({
      kind: "rejected",
      reason,
      actor,
      after: { textBytes, ...extra },
    });
    if (body.text.length > STANDALONE_DIAGNOSTICS_MAX_TEXT_CHARS) return reject("text_too_large");

    const opened = openSupportBlob(body.text, this.keys);
    if (!opened.ok)
      return reject(blobReason(opened.reason), opened.kid === undefined ? {} : { kid: opened.kid });
    const parsed = parseSupportPayload(opened.json, this.now());
    if (!parsed.ok) return reject(parsed.reason, { kid: opened.kid });
    const payload = parsed.payload;
    const hostKey = payload.v === 2 && payload.hostId !== null ? payload.hostId : "unknown";

    // Binding: a pasted report must belong to this tenant's site.
    const sites =
      hostKey === "unknown"
        ? []
        : await tx
            .select({
              id: schema.standaloneSites.id,
              tenantId: schema.standaloneSites.tenantId,
              hostId: schema.standaloneSites.hostId,
            })
            .from(schema.standaloneSites)
            .where(
              or(
                eq(schema.standaloneSites.hostId, hostKey),
                sql`${schema.standaloneSites.hostHistory} @> ${JSON.stringify([{ hostId: hostKey }])}::jsonb`,
              ),
            );
    // A host that is another tenant's CURRENT host is never ours, whatever our history says: the
    // history only helps when the host is unbound or currently ours.
    if (sites.some((site) => site.tenantId !== tenantId && site.hostId === hostKey))
      return reject("host_other_tenant", { kid: opened.kid });
    const own =
      sites.find((site) => site.tenantId === tenantId && site.hostId === hostKey) ??
      sites.find((site) => site.tenantId === tenantId);
    if (own === undefined && sites.length > 0)
      return reject("host_other_tenant", { kid: opened.kid });
    const unbound = own === undefined;
    if (unbound && body.acknowledgeUnboundHost !== true)
      return reject("host_unbound", { kid: opened.kid });

    // Idempotency: the token's hash (globally — the report's own, or one reserved by a token
    // re-made for the same instant), then the exact instant per host.
    const [byHash] = await tx
      .select({
        id: schema.standaloneSupportDiagnostics.id,
        tenantId: schema.standaloneSupportDiagnostics.tenantId,
      })
      .from(schema.standaloneSupportDiagnostics)
      .where(eq(schema.standaloneSupportDiagnostics.blobSha256, opened.blobSha256));
    const [byAlias] =
      byHash !== undefined
        ? []
        : await tx
            .select({
              id: schema.standaloneSupportTokenAliases.diagnosticId,
              tenantId: schema.standaloneSupportTokenAliases.tenantId,
            })
            .from(schema.standaloneSupportTokenAliases)
            .where(eq(schema.standaloneSupportTokenAliases.blobSha256, opened.blobSha256));
    const known = byHash ?? byAlias;
    if (known !== undefined && known.tenantId !== tenantId)
      return reject("token_conflict", { kid: opened.kid });
    const generatedAt = new Date(payload.generatedAt);
    const [byPair] =
      known !== undefined
        ? [known]
        : await tx
            .select({ id: schema.standaloneSupportDiagnostics.id })
            .from(schema.standaloneSupportDiagnostics)
            .where(
              and(
                eq(schema.standaloneSupportDiagnostics.tenantId, tenantId),
                eq(schema.standaloneSupportDiagnostics.hostKey, hostKey),
                eq(schema.standaloneSupportDiagnostics.generatedAt, generatedAt),
              ),
            );
    if (byPair !== undefined) {
      const existing = await this.row(tx, tenantId, byPair.id);
      // A token re-made for this instant: its hash now belongs to the report's tenant too.
      if (existing.blobSha256 !== opened.blobSha256 && byAlias === undefined)
        await tx.insert(schema.standaloneSupportTokenAliases).values({
          blobSha256: opened.blobSha256,
          tenantId,
          diagnosticId: existing.id,
        });
      await this.audit.record(tx, {
        actorPlatformUserId: actor.id,
        actorRole: actor.role,
        action: "standalone.diagnostics.ingest",
        outcome: "duplicate",
        tenantId,
        targetType: "standalone_support_diagnostic",
        targetId: existing.id,
        reason: null,
        requestId: null,
        before: null,
        after: this.auditAfter(existing, payload, hostKey, 0, 0, false, textBytes),
      });
      return {
        kind: "done",
        response: standaloneDiagnosticsIngestResponseSchema.parse({
          duplicate: true,
          diagnostic: diagnosticSummary(existing),
          monthsApplied: 0,
          monthsSkipped: 0,
        }),
      };
    }

    const id = randomUUID();
    const [inserted] = await tx
      .insert(schema.standaloneSupportDiagnostics)
      .values({
        id,
        tenantId,
        siteId: own?.id ?? null,
        hostKey,
        blobSha256: opened.blobSha256,
        kid: opened.kid,
        payloadVersion: payload.v,
        generatedAt,
        receivedByPlatformUserId: actor.id,
        appVersion: payload.appVersion,
        hostVersion: payload.hostVersion,
        pcRole: payload.v === 2 ? payload.role : null,
        devicesStation: payload.devices.station,
        devicesOffice: payload.devices.office,
        devicesHandheld: payload.devices.handheld,
        license: payload.v === 2 ? payload.license : null,
        payload,
      })
      .returning();
    if (!inserted) throw new Error("diagnostic insert returned no row");

    const applied = await tx
      .insert(schema.standaloneSupportUsageMonths)
      .values(
        payload.months.map((month) => ({
          tenantId,
          hostKey,
          month: month.month,
          stats: month,
          sourceDiagnosticId: id,
          sourceGeneratedAt: generatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          schema.standaloneSupportUsageMonths.tenantId,
          schema.standaloneSupportUsageMonths.hostKey,
          schema.standaloneSupportUsageMonths.month,
        ],
        set: {
          stats: sql`excluded.stats`,
          sourceDiagnosticId: sql`excluded.source_diagnostic_id`,
          sourceGeneratedAt: sql`excluded.source_generated_at`,
        },
        // The newest report wins by its own instant, not by arrival order.
        setWhere: sql`excluded.source_generated_at > ${schema.standaloneSupportUsageMonths.sourceGeneratedAt}`,
      })
      .returning({ month: schema.standaloneSupportUsageMonths.month });
    const monthsApplied = applied.length;
    const monthsSkipped = payload.months.length - monthsApplied;

    await this.audit.record(tx, {
      actorPlatformUserId: actor.id,
      actorRole: actor.role,
      action: "standalone.diagnostics.ingest",
      outcome: "success",
      tenantId,
      targetType: "standalone_support_diagnostic",
      targetId: id,
      reason: null,
      requestId: null,
      before: null,
      after: this.auditAfter(
        inserted,
        payload,
        hostKey,
        monthsApplied,
        monthsSkipped,
        unbound,
        textBytes,
      ),
    });
    return {
      kind: "done",
      response: standaloneDiagnosticsIngestResponseSchema.parse({
        duplicate: false,
        diagnostic: diagnosticSummary(inserted),
        monthsApplied,
        monthsSkipped,
      }),
    };
  }

  private auditAfter(
    row: DiagnosticRow,
    payload: StandaloneSupportPayload,
    hostKey: string,
    monthsApplied: number,
    monthsSkipped: number,
    unboundAcknowledged: boolean,
    textBytes: number,
  ) {
    return {
      blobSha256: row.blobSha256,
      kid: row.kid,
      payloadVersion: row.payloadVersion,
      hostKey,
      siteId: row.siteId,
      generatedAt: row.generatedAt.toISOString(),
      appVersion: row.appVersion,
      hostVersion: row.hostVersion,
      pcRole: row.pcRole,
      licenseState: payload.v === 2 ? (payload.license?.state ?? null) : null,
      monthsApplied,
      monthsSkipped,
      unboundAcknowledged,
      textBytes,
    };
  }

  private async row(
    tx: SubscriptionTransaction,
    tenantId: string,
    id: string,
  ): Promise<DiagnosticRow> {
    const [row] = await tx
      .select()
      .from(schema.standaloneSupportDiagnostics)
      .where(
        and(
          eq(schema.standaloneSupportDiagnostics.tenantId, tenantId),
          eq(schema.standaloneSupportDiagnostics.id, id),
        ),
      );
    if (!row) throw new NotFoundException();
    return row;
  }

  async history(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    query: StandaloneDiagnosticsHistoryQuery,
  ): Promise<StandaloneDiagnosticsHistory> {
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const cursor = query.cursor === undefined ? null : decodeHistoryCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null)
      throw new UnprocessableEntityException({ code: "standalone_diagnostics_cursor_invalid" });
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const t = schema.standaloneSupportDiagnostics;
        const found = await tx
          .select()
          .from(t)
          .where(
            and(
              eq(t.tenantId, tenantId),
              cursor === null
                ? undefined
                : or(
                    lt(t.generatedAt, cursor.generatedAt),
                    and(eq(t.generatedAt, cursor.generatedAt), lt(t.id, cursor.id)),
                  ),
            ),
          )
          .orderBy(desc(t.generatedAt), desc(t.id))
          .limit(limit + 1);
        const page = found.slice(0, limit);
        const last = page.at(-1);
        return standaloneDiagnosticsHistorySchema.parse({
          items: page.map(diagnosticSummary),
          nextCursor:
            found.length > limit && last ? encodeHistoryCursor(last.generatedAt, last.id) : null,
        });
      },
      "read only",
    );
  }

  async detail(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    diagnosticId: string,
  ): Promise<StandaloneDiagnosticDetail> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const row = await this.row(tx, tenantId, diagnosticId);
        const parsed = standaloneSupportPayloadSchema.parse(row.payload);
        return standaloneDiagnosticDetailSchema.parse({
          diagnostic: diagnosticSummary(row),
          devices: parsed.devices,
          months: parsed.months,
          license: parsed.v === 2 ? parsed.license : null,
        });
      },
      "read only",
    );
  }

  async overview(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
  ): Promise<StandaloneDiagnosticsOverview> {
    const latestVersion = await this.latest.latestPublishedVersion();
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const t = schema.standaloneSupportDiagnostics;
        const lastPerHost = await tx
          .selectDistinctOn([t.hostKey])
          .from(t)
          .where(eq(t.tenantId, tenantId))
          .orderBy(asc(t.hostKey), desc(t.generatedAt), desc(t.id));
        const siteIds = lastPerHost.flatMap((row) => (row.siteId === null ? [] : [row.siteId]));
        const sites = siteIds.length
          ? await tx
              .select({ id: schema.standaloneSites.id, name: schema.standaloneSites.name })
              .from(schema.standaloneSites)
              .where(
                and(
                  eq(schema.standaloneSites.tenantId, tenantId),
                  inArray(schema.standaloneSites.id, siteIds),
                ),
              )
          : [];
        const issuances = siteIds.length
          ? await tx
              .selectDistinctOn([schema.standaloneLicenseIssuances.siteId])
              .from(schema.standaloneLicenseIssuances)
              .where(
                and(
                  eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
                  inArray(schema.standaloneLicenseIssuances.siteId, siteIds),
                ),
              )
              .orderBy(
                asc(schema.standaloneLicenseIssuances.siteId),
                desc(schema.standaloneLicenseIssuances.sequence),
              )
          : [];
        const hosts = lastPerHost
          .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime())
          .map((row) => {
            const parsed = standaloneSupportPayloadSchema.safeParse(row.payload);
            const issued = issuances.find((issuance) => issuance.siteId === row.siteId);
            return {
              hostKey: row.hostKey,
              siteId: row.siteId,
              siteName: sites.find((site) => site.id === row.siteId)?.name ?? null,
              last: diagnosticSummary(row),
              license: parsed.success && parsed.data.v === 2 ? parsed.data.license : null,
              devices: {
                station: row.devicesStation,
                office: row.devicesOffice,
                handheld: row.devicesHandheld,
              },
              cloudLicense: issued
                ? { sequence: issued.sequence, validUntil: issued.validUntil.toISOString() }
                : null,
              outdated:
                latestVersion === null || row.appVersion === null
                  ? null
                  : isOlderVersion(row.appVersion, latestVersion),
            };
          });
        return standaloneDiagnosticsOverviewSchema.parse({
          hosts,
          latestPublishedVersion: latestVersion,
        });
      },
      "read only",
    );
  }

  async statistics(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    query: StandaloneDiagnosticsStatisticsQuery,
  ): Promise<StandaloneDiagnosticsStatistics> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false, READ_CAPABILITIES);
        const m = schema.standaloneSupportUsageMonths;
        const all = await tx.select().from(m).where(eq(m.tenantId, tenantId)).orderBy(asc(m.month));
        const hosts = [...new Set(all.map((row) => row.hostKey))].sort();
        const chosen = all.filter(
          (row) =>
            (query.hostKey === undefined || row.hostKey === query.hostKey) &&
            (query.from === undefined || row.month >= query.from) &&
            (query.to === undefined || row.month <= query.to),
        );
        const byMonth = new Map<string, typeof chosen>();
        for (const row of chosen) byMonth.set(row.month, [...(byMonth.get(row.month) ?? []), row]);
        return standaloneDiagnosticsStatisticsSchema.parse({
          hosts,
          multipleHosts: query.hostKey === undefined && hosts.length > 1,
          months: [...byMonth.entries()].map(([month, group]) => ({
            month,
            hostCount: group.length,
            stats: sumUsageMonths(group.map((row) => standaloneUsageTotalsSchema.parse(row.stats))),
          })),
        });
      },
      "read only",
    );
  }

  /**
   * Deletes reports older than 24 months (decision В6); their months go with them. Works in
   * batches so a backlog never holds one long lock. Returns the count.
   */
  async purgeExpired(): Promise<number> {
    const t = schema.standaloneSupportDiagnostics;
    const cutoff = retentionCutoff(this.now());
    let total = 0;
    for (;;) {
      const batch = await this.db
        .select({ id: t.id })
        .from(t)
        .where(lt(t.receivedAt, cutoff))
        .limit(PURGE_BATCH);
      if (batch.length === 0) return total;
      await this.db.delete(t).where(
        inArray(
          t.id,
          batch.map((row) => row.id),
        ),
      );
      total += batch.length;
      if (batch.length < PURGE_BATCH) return total;
    }
  }
}
