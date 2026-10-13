import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  standaloneSiteHostHistorySchema,
  standaloneSiteInspectionSchema,
  standaloneSiteListSchema,
  type PlatformPrincipal,
  type StandaloneSite,
  type StandaloneSiteInspectRequest,
  type StandaloneSiteInspection,
  type StandaloneSiteList,
  type StandaloneSiteRegister,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  findSite,
  issuanceSourceFor,
  readTenantInns,
  requireStandaloneLicenseActor,
  STANDALONE_LICENSE_CLOCK,
  type StandaloneLicenseClock,
} from "./standalone-license-authority";
import {
  STANDALONE_LICENSE_SIGNING,
  type StandaloneLicenseSigningConfiguration,
} from "./standalone-license-keyset";
import { standaloneTransaction } from "./standalone-license-transaction";
import { siteView, type StandaloneSiteRow } from "./standalone-license-views";
import { normalizedInn, sameWarnings, siteRegistrationWarnings } from "./standalone-inn-check";

const MAX_HOST_HISTORY = 100;
const conflict = (code: string) => new ConflictException({ code });

@Injectable()
export class StandaloneSitesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_LICENSE_SIGNING)
    private readonly signing: StandaloneLicenseSigningConfiguration | null,
    @Inject(STANDALONE_LICENSE_CLOCK) private readonly now: StandaloneLicenseClock,
  ) {}

  async list(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
  ): Promise<StandaloneSiteList> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        const { tenant } = await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const sites = await tx
          .select()
          .from(schema.standaloneSites)
          .where(eq(schema.standaloneSites.tenantId, tenantId))
          .orderBy(asc(schema.standaloneSites.createdAt), asc(schema.standaloneSites.id));
        const issuances = sites.length
          ? await tx
              .select()
              .from(schema.standaloneLicenseIssuances)
              .where(
                and(
                  eq(schema.standaloneLicenseIssuances.tenantId, tenantId),
                  inArray(
                    schema.standaloneLicenseIssuances.siteId,
                    sites.map((site) => site.id),
                  ),
                ),
              )
              .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
          : [];
        const now = this.now();
        return standaloneSiteListSchema.parse({
          tenantId,
          signingConfigured: this.signing !== null,
          issuanceSource: issuanceSourceFor(tenant.cabinetAccess),
          sites: sites.map((site) =>
            siteView(site, issuances.find((row) => row.siteId === site.id) ?? null, now),
          ),
        });
      },
      "read only",
    );
  }

  async inspect(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneSiteInspectRequest,
  ): Promise<StandaloneSiteInspection> {
    return standaloneTransaction(
      this.db,
      async (tx) => {
        await requireStandaloneLicenseActor(tx, principal, tenantId, false);
        const { request } = body;
        const inns = await readTenantInns(tx, tenantId);
        const [holder] = await tx
          .select({
            id: schema.standaloneSites.id,
            name: schema.standaloneSites.name,
            tenantId: schema.standaloneSites.tenantId,
          })
          .from(schema.standaloneSites)
          .where(eq(schema.standaloneSites.hostId, request.hostId));
        const trialInn = request.trial === null ? null : request.trial.inn;
        return standaloneSiteInspectionSchema.parse({
          hostId: request.hostId,
          hostVersion: request.hostVersion,
          organizationName: request.organization.name.slice(0, 500) || null,
          usage: {
            stations: request.usage.stations,
            cabinetUsers: request.usage.cabinetUsers,
            lines: request.usage.lines,
          },
          innFacts: {
            requestInn: normalizedInn(request.organization.inn),
            orgInn: normalizedInn(inns.orgInn),
            billingInn: normalizedInn(inns.billingInn),
            trialInn: normalizedInn(trialInn),
          },
          warnings: siteRegistrationWarnings({
            requestInn: request.organization.inn,
            trialInn,
            orgInn: inns.orgInn,
            billingInn: inns.billingInn,
          }),
          blocking: !holder
            ? null
            : holder.tenantId === tenantId
              ? "host_registered"
              : "host_taken",
          registeredSite:
            holder && holder.tenantId === tenantId ? { id: holder.id, name: holder.name } : null,
        });
      },
      "read only",
    );
  }

  /** `create` binds a new site; `rebind` moves an existing site to a new host id (spec §6.3). */
  async register(
    principal: PlatformPrincipal | undefined,
    tenantId: string,
    body: StandaloneSiteRegister,
  ): Promise<StandaloneSite> {
    return standaloneTransaction(this.db, async (tx) => {
      const { user } = await requireStandaloneLicenseActor(tx, principal, tenantId, true);
      const now = this.now();
      const { request } = body;
      let site: StandaloneSiteRow | null = null;
      if (body.intent === "create") {
        const [replay] = await tx
          .select()
          .from(schema.standaloneSites)
          .where(
            and(
              eq(schema.standaloneSites.tenantId, tenantId),
              eq(schema.standaloneSites.requestId, body.requestId),
            ),
          );
        if (replay) {
          if (replay.hostId !== request.hostId || replay.createdByPlatformUserId !== user.id)
            throw conflict("standalone_site_request_conflict");
          return this.view(tx, replay, now);
        }
      } else {
        site = await findSite(tx, tenantId, body.siteId, true);
        const history = standaloneSiteHostHistorySchema.parse(site.hostHistory);
        const replay = history.find((entry) => entry.requestId === body.requestId);
        if (replay) {
          if (replay.hostId !== request.hostId || replay.boundByPlatformUserId !== user.id)
            throw conflict("standalone_site_request_conflict");
          return this.view(tx, site, now);
        }
        if (site.hostId === request.hostId) throw conflict("standalone_site_host_unchanged");
        if (history.length >= MAX_HOST_HISTORY) throw conflict("standalone_site_history_full");
      }
      const [holder] = await tx
        .select({ tenantId: schema.standaloneSites.tenantId })
        .from(schema.standaloneSites)
        .where(eq(schema.standaloneSites.hostId, request.hostId));
      if (holder)
        throw conflict(
          holder.tenantId === tenantId
            ? "standalone_site_host_registered"
            : "standalone_site_host_taken",
        );
      const inns = await readTenantInns(tx, tenantId);
      const warnings = siteRegistrationWarnings({
        requestInn: request.organization.inn,
        trialInn: request.trial === null ? null : request.trial.inn,
        orgInn: inns.orgInn,
        billingInn: inns.billingInn,
      });
      if (!sameWarnings(warnings, body.acknowledgedWarnings))
        throw conflict("standalone_site_warnings_unacknowledged");
      const requestInn = normalizedInn(request.organization.inn);
      const entry = {
        hostId: request.hostId,
        requestInn,
        requestId: body.requestId,
        boundAt: now.toISOString(),
        boundByPlatformUserId: user.id,
      };
      if (body.intent === "create") {
        const id = randomUUID();
        const [row] = await tx
          .insert(schema.standaloneSites)
          .values({
            id,
            tenantId,
            hostId: request.hostId,
            name: body.name,
            requestInn,
            lastActivationRequest: request,
            hostHistory: [entry],
            requestId: body.requestId,
            createdByPlatformUserId: user.id,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!row) throw new Error("standalone site insert returned no row");
        await this.audit.record(tx, {
          actorPlatformUserId: user.id,
          actorRole: user.role,
          action: "standalone_site.registered",
          outcome: "success",
          tenantId,
          targetType: "standalone_site",
          targetId: id,
          reason: null,
          requestId: body.requestId,
          before: null,
          after: { siteId: id, hostId: request.hostId, name: body.name, requestInn, warnings },
        });
        return this.view(tx, row, now);
      }
      if (!site) throw new Error("rebind without a site");
      const history = standaloneSiteHostHistorySchema.parse(site.hostHistory);
      const [row] = await tx
        .update(schema.standaloneSites)
        .set({
          hostId: request.hostId,
          requestInn,
          lastActivationRequest: request,
          hostHistory: [...history, entry],
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.standaloneSites.tenantId, tenantId),
            eq(schema.standaloneSites.id, site.id),
          ),
        )
        .returning();
      if (!row) throw new Error("standalone site update returned no row");
      await this.audit.record(tx, {
        actorPlatformUserId: user.id,
        actorRole: user.role,
        action: "standalone_site.host_rebound",
        outcome: "success",
        tenantId,
        targetType: "standalone_site",
        targetId: site.id,
        reason: null,
        requestId: body.requestId,
        before: { hostId: site.hostId, requestInn: site.requestInn },
        after: { siteId: site.id, hostId: request.hostId, requestInn, warnings },
      });
      return this.view(tx, row, now);
    });
  }

  private async view(tx: SubscriptionTransaction, site: StandaloneSiteRow, now: Date) {
    const [latest] = await tx
      .select()
      .from(schema.standaloneLicenseIssuances)
      .where(
        and(
          eq(schema.standaloneLicenseIssuances.tenantId, site.tenantId),
          eq(schema.standaloneLicenseIssuances.siteId, site.id),
        ),
      )
      .orderBy(desc(schema.standaloneLicenseIssuances.sequence))
      .limit(1);
    return siteView(site, latest ?? null, now);
  }
}
