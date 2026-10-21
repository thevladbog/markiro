import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import {
  LANDING_LEAD_DEFAULT_TOUCH_DAYS,
  type LandingLeadStatus,
  type PlatformLeadContacted,
  type PlatformLeadCreateTenant,
  type PlatformLeadDetail,
  type PlatformLeadListQuery,
  type PlatformLeadListResponse,
  type PlatformLeadSummary,
  type PlatformLeadUpdate,
} from "@markiro/platform-contracts";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { TenantProvisioningService } from "../platform-tenants/tenant-provisioning.service";
import { anonymizeLead } from "./lead-anonymization";
import { LEAD_DIGEST_TIME_ZONE } from "./lead-digest-sections";
import { insertLeadEvent } from "./landing-lead-writer";

const DAY_MS = 86_400_000;
const EVENT_LIMIT = 200;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type LeadRow = {
  id: string;
  email: string | null;
  company: string | null;
  name: string | null;
  phone: string | null;
  inn: string | null;
  productGroup: string | null;
  linesBucket: "1" | "2-3" | "4+" | null;
  locale: "ru" | "en";
  status: LandingLeadStatus;
  statusChangedAt: Date;
  nextTouchAt: Date | null;
  ownerNote: string | null;
  tenantId: string | null;
  firstSourcePath: string;
  firstUtm: Record<string, string> | null;
  firstReferrer: string | null;
  anonymizedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function leadNotFound(): NotFoundException {
  return new NotFoundException({ code: "lead_not_found" });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The «Заявки» section of the SaaS admin (spec §15.6). */
@Injectable()
export class PlatformLeadsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  now: () => Date = () => new Date();
  createId: () => string = randomUUID;

  async list(query: PlatformLeadListQuery): Promise<PlatformLeadListResponse> {
    const filters: SQL[] = [];
    if (query.search !== undefined && query.search !== "") {
      const pattern = `%${escapeLike(query.search.toLowerCase())}%`;
      filters.push(
        sql`(lower(coalesce(l.company, '')) LIKE ${pattern} OR lower(coalesce(l.email, '')) LIKE ${pattern} OR coalesce(l.inn, '') LIKE ${pattern})`,
      );
    }
    if (query.status !== undefined) filters.push(sql`l.status = ${query.status}`);
    if (query.kind !== undefined) {
      filters.push(
        sql`EXISTS (SELECT 1 FROM landing_lead_events AS k WHERE k.lead_id = l.id AND k.kind = ${query.kind})`,
      );
    }
    if (query.from !== undefined) {
      filters.push(
        sql`(l.created_at AT TIME ZONE ${LEAD_DIGEST_TIME_ZONE})::date >= ${query.from}::date`,
      );
    }
    if (query.to !== undefined) {
      filters.push(
        sql`(l.created_at AT TIME ZONE ${LEAD_DIGEST_TIME_ZONE})::date <= ${query.to}::date`,
      );
    }
    const where = filters.length === 0 ? sql`TRUE` : sql.join(filters, sql` AND `);
    const offset = (query.page - 1) * query.limit;
    const [rows, count] = await Promise.all([
      this.db.execute<{
        id: string;
        company: string | null;
        email: string | null;
        inn: string | null;
        status: LandingLeadStatus;
        nextTouchAt: Date | null;
        tariffCode: string | null;
        lastEventKind: string | null;
        lastEventAt: Date | null;
        tenantId: string | null;
        anonymized: boolean;
        createdAt: Date;
      }>(sql`
        SELECT l.id::text AS id, l.company, l.email, l.inn, l.status,
          l.next_touch_at AS "nextTouchAt", l.tenant_id AS "tenantId",
          l.anonymized_at IS NOT NULL AS anonymized, l.created_at AS "createdAt",
          last_event.kind AS "lastEventKind", last_event.created_at AS "lastEventAt",
          tariff.code AS "tariffCode"
        FROM landing_leads AS l
        LEFT JOIN LATERAL (
          SELECT e.kind, e.created_at FROM landing_lead_events AS e
          WHERE e.lead_id = l.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1
        ) AS last_event ON TRUE
        LEFT JOIN LATERAL (
          SELECT e.payload ->> 'tariffCode' AS code FROM landing_lead_events AS e
          WHERE e.lead_id = l.id AND e.kind = 'invoice_request'
          ORDER BY e.created_at DESC, e.id DESC LIMIT 1
        ) AS tariff ON TRUE
        WHERE ${where}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `),
      this.db.execute<{ total: number }>(
        sql`SELECT count(*)::int AS total FROM landing_leads AS l WHERE ${where}`,
      ),
    ]);
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        company: row.company,
        email: row.email,
        inn: row.inn,
        status: row.status,
        nextTouchAt: row.nextTouchAt === null ? null : new Date(row.nextTouchAt).toISOString(),
        tariffCode: row.tariffCode,
        lastEvent:
          row.lastEventKind === null || row.lastEventAt === null
            ? null
            : {
                kind: row.lastEventKind as PlatformLeadDetail["events"][number]["kind"],
                createdAt: new Date(row.lastEventAt).toISOString(),
              },
        tenantId: row.tenantId,
        anonymized: row.anonymized,
        createdAt: new Date(row.createdAt).toISOString(),
      })),
      total: count.rows[0]?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async summary(): Promise<PlatformLeadSummary> {
    const result = await this.db.execute<{ newCount: number }>(sql`
      SELECT count(*)::int AS "newCount" FROM landing_leads
      WHERE status = 'new' AND anonymized_at IS NULL
    `);
    return { newCount: result.rows[0]?.newCount ?? 0 };
  }

  async detail(id: string): Promise<PlatformLeadDetail> {
    return this.readDetail(this.db, id);
  }

  async update(
    actor: PlatformPrincipal,
    id: string,
    input: PlatformLeadUpdate,
  ): Promise<PlatformLeadDetail> {
    return this.db.transaction(async (tx) => {
      const lead = await this.lockLead(tx, id);
      const now = this.now();
      if (input.ownerNote !== undefined && lead.anonymizedAt !== null) {
        throw new ConflictException({ code: "lead_anonymized" });
      }
      const ownerNote =
        input.ownerNote === undefined
          ? lead.ownerNote
          : input.ownerNote === null || input.ownerNote === ""
            ? null
            : input.ownerNote;
      const nextTouchAt =
        input.nextTouchAt === undefined
          ? lead.nextTouchAt
          : input.nextTouchAt === null
            ? null
            : new Date(input.nextTouchAt);
      const status = input.status ?? lead.status;
      const statusChanged = status !== lead.status;
      await tx.execute(sql`
        UPDATE landing_leads SET
          status = ${status},
          status_changed_at = ${statusChanged ? now : lead.statusChangedAt},
          owner_note = ${ownerNote},
          next_touch_at = ${nextTouchAt},
          updated_at = ${now}
        WHERE id = ${id}::uuid
      `);
      if (statusChanged) await this.recordStatusChange(tx, actor, lead, status, now, null);
      if (ownerNote !== lead.ownerNote) {
        await insertLeadEvent(
          tx,
          {
            leadId: id,
            kind: "note",
            payload: { length: ownerNote?.length ?? 0 },
            actorPlatformUserId: actor.userId,
          },
          now,
          this.createId,
        );
      }
      return this.readDetail(tx, id);
    });
  }

  /** «Написал»: `contacted` (only from `new`) and the next touch, by default in three days. */
  async contacted(
    actor: PlatformPrincipal,
    id: string,
    input: PlatformLeadContacted,
  ): Promise<PlatformLeadDetail> {
    return this.db.transaction(async (tx) => {
      const lead = await this.lockLead(tx, id);
      const now = this.now();
      const nextTouchAt =
        input.nextTouchAt === undefined
          ? new Date(now.getTime() + LANDING_LEAD_DEFAULT_TOUCH_DAYS * DAY_MS)
          : new Date(input.nextTouchAt);
      const status: LandingLeadStatus = lead.status === "new" ? "contacted" : lead.status;
      const statusChanged = status !== lead.status;
      await tx.execute(sql`
        UPDATE landing_leads SET
          status = ${status},
          status_changed_at = ${statusChanged ? now : lead.statusChangedAt},
          next_touch_at = ${nextTouchAt},
          updated_at = ${now}
        WHERE id = ${id}::uuid
      `);
      if (statusChanged) {
        await this.recordStatusChange(tx, actor, lead, status, now, nextTouchAt);
      } else {
        await insertLeadEvent(
          tx,
          {
            leadId: id,
            kind: "touch",
            payload: { nextTouchAt: nextTouchAt.toISOString() },
            actorPlatformUserId: actor.userId,
          },
          now,
          this.createId,
        );
      }
      return this.readDetail(tx, id);
    });
  }

  async linkTenant(
    actor: PlatformPrincipal,
    id: string,
    tenantId: string,
    created = false,
  ): Promise<PlatformLeadDetail> {
    return this.db.transaction(async (tx) => {
      const lead = await this.lockLead(tx, id);
      const tenant = await tx.execute<{ id: string }>(
        sql`SELECT id FROM organization WHERE id = ${tenantId}`,
      );
      if (tenant.rows.length === 0) throw new NotFoundException({ code: "lead_tenant_not_found" });
      if (lead.tenantId === tenantId) return this.readDetail(tx, id);
      const now = this.now();
      await tx.execute(sql`
        UPDATE landing_leads SET tenant_id = ${tenantId}, updated_at = ${now}
        WHERE id = ${id}::uuid
      `);
      await insertLeadEvent(
        tx,
        {
          leadId: id,
          kind: "linked_tenant",
          payload: { tenantId, created, previousTenantId: lead.tenantId },
          actorPlatformUserId: actor.userId,
        },
        now,
        this.createId,
      );
      await this.audit.record(tx, {
        actorPlatformUserId: actor.userId,
        actorRole: actor.role,
        action: "landing_lead.tenant_linked",
        outcome: "success",
        tenantId,
        targetType: "landing_lead",
        targetId: id,
        reason: created ? "tenant_created" : "tenant_selected",
        before: { tenantId: lead.tenantId },
        after: { tenantId },
        requestId: null,
      });
      return this.readDetail(tx, id);
    });
  }

  /**
   * «Создать клиента без кабинета»: the existing provisioning (its own transaction and
   * audit), then the link. Provisioning treats an existing slug as an idempotent retry,
   * so a slug that already names a tenant is refused here unless it is this lead's own
   * client — «create» never silently attaches someone else's tenant.
   */
  async createTenant(
    actor: PlatformPrincipal,
    id: string,
    input: PlatformLeadCreateTenant,
  ): Promise<PlatformLeadDetail> {
    const lead = await this.db.execute<{ tenantId: string | null }>(
      sql`SELECT tenant_id AS "tenantId" FROM landing_leads WHERE id = ${id}::uuid`,
    );
    const current = lead.rows[0];
    if (!current) throw leadNotFound();
    const taken = await this.db.execute<{ id: string }>(
      sql`SELECT id FROM organization WHERE slug = ${input.tenantSlug}`,
    );
    const existing = taken.rows[0];
    if (existing) {
      if (existing.id === current.tenantId) return this.readDetail(this.db, id);
      throw new ConflictException({ code: "lead_tenant_slug_taken" });
    }
    const tenant = await this.provisioning.provision(
      { tenantName: input.tenantName, tenantSlug: input.tenantSlug, cabinetAccess: "none" },
      { actor },
    );
    return this.linkTenant(actor, id, tenant.tenantId, true);
  }

  async anonymize(actor: PlatformPrincipal, id: string): Promise<PlatformLeadDetail> {
    return this.db.transaction(async (tx) => {
      await this.lockLead(tx, id);
      await anonymizeLead(tx, this.audit, {
        leadId: id,
        reason: "manual",
        actor,
        now: this.now(),
        createId: this.createId,
      });
      return this.readDetail(tx, id);
    });
  }

  private async recordStatusChange(
    tx: Tx,
    actor: PlatformPrincipal,
    lead: LeadRow,
    status: LandingLeadStatus,
    now: Date,
    nextTouchAt: Date | null,
  ): Promise<void> {
    await insertLeadEvent(
      tx,
      {
        leadId: lead.id,
        kind: "status_change",
        payload: {
          from: lead.status,
          to: status,
          ...(nextTouchAt === null ? {} : { nextTouchAt: nextTouchAt.toISOString() }),
        },
        actorPlatformUserId: actor.userId,
      },
      now,
      this.createId,
    );
    await this.audit.record(tx, {
      actorPlatformUserId: actor.userId,
      actorRole: actor.role,
      action: "landing_lead.status_changed",
      outcome: "success",
      tenantId: lead.tenantId,
      targetType: "landing_lead",
      targetId: lead.id,
      reason: null,
      before: { status: lead.status },
      after: { status },
      requestId: null,
    });
  }

  private async lockLead(tx: Tx, id: string): Promise<LeadRow> {
    const result = await tx.execute<LeadRow>(
      sql`${LEAD_COLUMNS} WHERE l.id = ${id}::uuid FOR UPDATE`,
    );
    const row = result.rows[0];
    if (!row) throw leadNotFound();
    return row;
  }

  private async readDetail(executor: Pick<Db, "execute">, id: string): Promise<PlatformLeadDetail> {
    const result = await executor.execute<LeadRow>(sql`${LEAD_COLUMNS} WHERE l.id = ${id}::uuid`);
    const lead = result.rows[0];
    if (!lead) throw leadNotFound();
    // Sequential on purpose: inside a transaction all three share one connection.
    const tenant =
      lead.tenantId === null
        ? null
        : ((
            await executor.execute<{ id: string; name: string; cabinetAccess: "enabled" | "none" }>(
              sql`SELECT id, name, cabinet_access AS "cabinetAccess" FROM organization WHERE id = ${lead.tenantId}`,
            )
          ).rows[0] ?? null);
    const events = await executor.execute<{
      id: string;
      kind: PlatformLeadDetail["events"][number]["kind"];
      payload: Record<string, unknown>;
      actorId: string | null;
      actorName: string | null;
      createdAt: Date;
    }>(sql`
      SELECT e.id::text AS id, e.kind, e.payload, e.actor_platform_user_id AS "actorId",
        u.name AS "actorName", e.created_at AS "createdAt"
      FROM landing_lead_events AS e
      LEFT JOIN platform_users AS u ON u.id = e.actor_platform_user_id
      WHERE e.lead_id = ${id}::uuid
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ${EVENT_LIMIT}
    `);
    const tariff = await executor.execute<{ code: string | null }>(sql`
      SELECT payload ->> 'tariffCode' AS code FROM landing_lead_events
      WHERE lead_id = ${id}::uuid AND kind = 'invoice_request'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `);
    const iso = (value: Date | string) => new Date(value).toISOString();
    return {
      id: lead.id,
      email: lead.email,
      company: lead.company,
      name: lead.name,
      phone: lead.phone,
      inn: lead.inn,
      productGroup: lead.productGroup,
      linesBucket: lead.linesBucket,
      locale: lead.locale,
      status: lead.status,
      statusChangedAt: iso(lead.statusChangedAt),
      nextTouchAt: lead.nextTouchAt === null ? null : iso(lead.nextTouchAt),
      ownerNote: lead.ownerNote,
      tariffCode: tariff.rows[0]?.code ?? null,
      firstSourcePath: lead.firstSourcePath,
      firstUtm: lead.firstUtm,
      firstReferrer: lead.firstReferrer,
      tenant,
      anonymizedAt: lead.anonymizedAt === null ? null : iso(lead.anonymizedAt),
      createdAt: iso(lead.createdAt),
      updatedAt: iso(lead.updatedAt),
      events: events.rows.map((event) => ({
        id: event.id,
        kind: event.kind,
        payload: event.payload,
        actor: event.actorId === null ? null : { id: event.actorId, name: event.actorName },
        createdAt: iso(event.createdAt),
      })),
    };
  }
}

const LEAD_COLUMNS = sql`
  SELECT l.id::text AS id, l.email, l.company, l.name, l.phone, l.inn,
    l.product_group AS "productGroup", l.lines_bucket AS "linesBucket", l.locale, l.status,
    l.status_changed_at AS "statusChangedAt", l.next_touch_at AS "nextTouchAt",
    l.owner_note AS "ownerNote", l.tenant_id AS "tenantId",
    l.first_source_path AS "firstSourcePath", l.first_utm AS "firstUtm",
    l.first_referrer AS "firstReferrer", l.anonymized_at AS "anonymizedAt",
    l.created_at AS "createdAt", l.updated_at AS "updatedAt"
  FROM landing_leads AS l`;
