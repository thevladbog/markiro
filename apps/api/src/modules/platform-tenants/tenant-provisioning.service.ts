import { randomBytes, randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { MailDeliveryService } from "../mail/mail-delivery.service";
import { activationIdentifier } from "../tenant-owner-activation/token";
import { provisionTenantSchema, type ProvisionTenantDto } from "./dto";

export const TENANT_OWNER_ACTIVATION_BASE_URL = "TENANT_OWNER_ACTIVATION_BASE_URL";

type ProvisionTransaction = Parameters<Db["transaction"]>[0] extends (arg: infer T) => unknown
  ? T
  : never;

export interface TenantProvisioningResult {
  tenantId: string;
  userId: string;
  memberId: string;
  deliveryId: string;
}

export interface TenantProvisioningOptions {
  actor?: PlatformPrincipal;
  allowUnmanagedWithoutDemo?: boolean;
  renewActivation?: boolean;
  now?: () => Date;
  createId?: () => string;
  createToken?: () => string;
}

interface DefaultDemo {
  versionId: string;
  durationDays: number;
}

class DefaultDemoChanged extends Error {}

@Injectable()
export class TenantProvisioningService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly mail: MailDeliveryService,
    private readonly audit: PlatformAuditService,
    @Inject(TENANT_OWNER_ACTIVATION_BASE_URL) private readonly adminOrigin: string,
  ) {}

  async provision(
    rawInput: ProvisionTenantDto,
    options: TenantProvisioningOptions = {},
  ): Promise<TenantProvisioningResult> {
    const input = provisionTenantSchema.parse(rawInput);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.db.transaction((tx) => this.provisionInTransaction(tx, input, options));
      } catch (error) {
        if (error instanceof DefaultDemoChanged && attempt < 3) continue;
        throw error;
      }
    }
    throw new ConflictException({ code: "default_demo_changed" });
  }

  private async provisionInTransaction(
    tx: ProvisionTransaction,
    input: ProvisionTenantDto,
    options: TenantProvisioningOptions,
  ): Promise<TenantProvisioningResult> {
    const now = options.now ?? (() => new Date());
    const createId = options.createId ?? randomUUID;
    const createToken = options.createToken ?? (() => randomBytes(24).toString("base64url"));
    const operationAt = now();

    // This order is shared by CLI and browser provisioning. It serializes a
    // normalized identity before a slug, preventing the same new account
    // from becoming the first owner of two tenants concurrently.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-email:${input.email}`}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-slug:${input.tenantSlug}`}, 0))`,
    );

    let [tenant] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, input.tenantSlug))
      .limit(1);
    const tenantCreated = !tenant;
    // Existing tenants keep their historical managed/unmanaged state. A
    // default demo is required only before the organization insert, never
    // to renew an existing owner's activation or to retry idempotently.
    const demo = tenant
      ? null
      : await this.lockDefaultDemo(tx, options.allowUnmanagedWithoutDemo === true);
    if (!tenant) {
      tenant = { id: createId() };
      await tx.insert(schema.organization).values({
        id: tenant.id,
        name: input.tenantName,
        slug: input.tenantSlug,
        createdAt: operationAt,
      });
      await tx
        .insert(schema.pickupTenantPolicies)
        .values({ tenantId: tenant.id, limitsEnabled: true, updatedAt: operationAt });
    }

    let [user] = await tx
      .select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, input.email))
      .limit(1);
    if (!user) {
      user = { id: createId(), emailVerified: false };
      await tx.insert(schema.user).values({
        id: user.id,
        email: input.email,
        name: input.email,
        emailVerified: false,
      });
    }

    const tenantMembers = await tx
      .select({
        id: schema.member.id,
        userId: schema.member.userId,
        role: schema.member.role,
      })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenant.id));
    const existingMember = tenantMembers.find((member) => member.userId === user.id);
    if (tenantMembers.length > 0 && !existingMember) {
      throw new ConflictException({ code: "tenant_first_owner_conflict" });
    }
    if (existingMember && existingMember.role !== "owner") {
      throw new ConflictException({ code: "tenant_first_member_not_owner" });
    }

    await tx
      .insert(schema.userProfiles)
      .values({ userId: user.id, firstName: "", lastName: "" })
      .onConflictDoNothing({ target: schema.userProfiles.userId });

    const memberId = existingMember?.id ?? createId();
    if (!existingMember) {
      await tx.insert(schema.member).values({
        id: memberId,
        organizationId: tenant.id,
        userId: user.id,
        role: "owner",
        createdAt: operationAt,
      });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenant.id,
        actorUserId: null,
        action: "tenant.owner.provisioned",
        outcome: "success",
        targetType: "member",
        targetId: memberId,
      });
    }

    const sourceId = `tenant-owner:${tenant.id}`;
    const subjectValue = JSON.stringify({ userId: user.id, tenantId: tenant.id });
    let [existingDelivery] = await tx
      .select({ id: schema.emailDeliveries.id, status: schema.emailDeliveries.status })
      .from(schema.emailDeliveries)
      .where(
        and(
          eq(schema.emailDeliveries.userId, user.id),
          eq(schema.emailDeliveries.kind, "tenant-owner-activation"),
          eq(schema.emailDeliveries.sourceId, sourceId),
        ),
      )
      .orderBy(desc(schema.emailDeliveries.createdAt), desc(schema.emailDeliveries.id))
      .limit(1);

    let deliveryId = existingDelivery?.id;
    if (options.renewActivation && existingDelivery) {
      if (user.emailVerified) {
        throw new ConflictException({ code: "owner_already_activated" });
      }
      const deliveryLock = await tx.execute(
        sql<{
          locked: boolean;
        }>`select pg_try_advisory_xact_lock(hashtextextended(${existingDelivery.id}, 0)) as locked`,
      );
      if (deliveryLock.rows[0]?.locked !== true) {
        throw new ConflictException({ code: "activation_delivery_sending" });
      }
      const [lockedDelivery] = await tx
        .select({ id: schema.emailDeliveries.id, status: schema.emailDeliveries.status })
        .from(schema.emailDeliveries)
        .where(eq(schema.emailDeliveries.id, existingDelivery.id))
        .limit(1);
      if (!lockedDelivery) throw new ConflictException({ code: "activation_delivery_missing" });
      existingDelivery = lockedDelivery;
      if (lockedDelivery.status === "sending") {
        throw new ConflictException({ code: "activation_delivery_sending" });
      }
      if (lockedDelivery.status === "sent") {
        const scrubbed = await tx
          .update(schema.emailDeliveries)
          .set({
            encryptedPayload: null,
            payloadNonce: null,
            payloadTag: null,
            updatedAt: operationAt,
          })
          .where(
            and(
              eq(schema.emailDeliveries.id, lockedDelivery.id),
              eq(schema.emailDeliveries.status, "sent"),
            ),
          )
          .returning({ id: schema.emailDeliveries.id });
        if (scrubbed.length !== 1) {
          throw new ConflictException({ code: "activation_delivery_changed" });
        }
      } else {
        const canceled = await tx
          .update(schema.emailDeliveries)
          .set({
            status: "canceled",
            encryptedPayload: null,
            payloadNonce: null,
            payloadTag: null,
            attemptId: null,
            attemptDeadline: null,
            terminalAt: operationAt,
            updatedAt: operationAt,
          })
          .where(
            and(
              eq(schema.emailDeliveries.id, lockedDelivery.id),
              inArray(schema.emailDeliveries.status, ["queued", "retrying", "failed", "canceled"]),
            ),
          )
          .returning({ id: schema.emailDeliveries.id });
        if (canceled.length !== 1) {
          throw new ConflictException({ code: "activation_delivery_changed" });
        }
      }
      await tx
        .delete(schema.emailOutbox)
        .where(eq(schema.emailOutbox.deliveryId, lockedDelivery.id));
      await tx
        .delete(schema.verification)
        .where(
          and(
            eq(schema.verification.value, subjectValue),
            sql`${schema.verification.identifier} like 'tenant-owner-activation:%'`,
          ),
        );
      deliveryId = undefined;
    }

    if (!deliveryId) {
      const token = createToken();
      const expiresAt = new Date(operationAt.getTime() + 60 * 60 * 1_000);
      await tx.insert(schema.verification).values({
        id: createId(),
        identifier: activationIdentifier(token),
        value: subjectValue,
        expiresAt,
      });
      const actionUrl = new URL("/activate-owner", this.adminOrigin);
      actionUrl.hash = new URLSearchParams({ token }).toString();
      deliveryId = await this.mail.enqueue(tx, {
        scope: { userId: user.id },
        recipient: input.email,
        sourceId,
        template: {
          kind: "tenant-owner-activation",
          recipientName: "Пользователь",
          organizationName: input.tenantName,
          actionUrl: actionUrl.toString(),
          expiresInMinutes: 60,
        },
      });
      if (options.renewActivation && existingDelivery) {
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenant.id,
          actorUserId: null,
          action: "tenant.owner.activation_renewed",
          outcome: "success",
          targetType: "email_delivery",
          targetId: deliveryId,
        });
        if (options.actor) {
          await this.audit.record(tx, {
            actorPlatformUserId: options.actor.userId,
            actorRole: options.actor.role,
            action: "platform.tenant.owner.activation_renewed",
            outcome: "success",
            tenantId: tenant.id,
            targetType: "email_delivery",
            targetId: deliveryId,
            reason: null,
            before: { deliveryId: existingDelivery.id, status: existingDelivery.status },
            after: { deliveryId, status: "queued" },
            requestId: null,
          });
        }
      }
    }

    let subscriptionId: string | null = null;
    if (tenantCreated && demo) {
      subscriptionId = createId();
      await tx.insert(schema.tenantSubscriptions).values({
        id: subscriptionId,
        tenantId: tenant.id,
        planVersionId: demo.versionId,
        status: "pending_activation",
        startsAt: null,
        endsAt: null,
        source: "demo",
        createdByPlatformUserId: options.actor?.userId ?? null,
        createdAt: operationAt,
        updatedAt: operationAt,
      });
      await tx.insert(schema.subscriptionEvents).values({
        tenantId: tenant.id,
        subscriptionId,
        eventKind: "demo.provisioned",
        effectiveAt: operationAt,
        actorPlatformUserId: options.actor?.userId ?? null,
        source: options.actor ? "platform" : "cli",
        reason: null,
        before: null,
        after: {
          status: "pending_activation",
          planVersionId: demo.versionId,
          demoDurationDays: demo.durationDays,
        },
      });
    }

    if (tenantCreated) {
      const unmanaged = demo === null;
      await this.audit.record(tx, {
        actorPlatformUserId: options.actor?.userId ?? null,
        actorRole: options.actor?.role ?? null,
        action: unmanaged ? "platform.tenant.created_unmanaged" : "platform.tenant.created",
        outcome: "success",
        tenantId: tenant.id,
        targetType: "tenant",
        targetId: tenant.id,
        reason: unmanaged ? "operator_allowed_unmanaged_without_default_demo" : null,
        before: null,
        after: {
          ownerUserId: user.id,
          ownerMemberId: memberId,
          subscriptionId,
          subscriptionStatus: unmanaged ? "unmanaged" : "pending_activation",
          planVersionId: demo?.versionId ?? null,
        },
        requestId: null,
      });
    }

    return { tenantId: tenant.id, userId: user.id, memberId, deliveryId };
  }

  private async lockDefaultDemo(
    tx: ProvisionTransaction,
    allowUnmanaged: boolean,
  ): Promise<DefaultDemo | null> {
    const [observed] = await tx
      .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, "default"));
    if (!observed) {
      await this.lockDefaultSetting(tx);
      const [confirmed] = await tx
        .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
        .from(schema.platformSettings)
        .where(eq(schema.platformSettings.key, "default"));
      if (confirmed) throw new DefaultDemoChanged();
      if (allowUnmanaged) return null;
      throw new ConflictException({ code: "default_demo_not_configured" });
    }

    // Candidate version before setting is the catalog lock order used by
    // default selection and retirement. If selection changes while this
    // transaction waits, roll back all locks and retry from the beginning.
    await tx.execute(
      sql`select id from catalog_item_versions where id = ${observed.versionId} for key share`,
    );
    await this.lockDefaultSetting(tx);
    const [setting] = await tx
      .select({ versionId: schema.platformSettings.defaultDemoCatalogVersionId })
      .from(schema.platformSettings)
      .where(eq(schema.platformSettings.key, "default"));
    if (setting?.versionId !== observed.versionId) throw new DefaultDemoChanged();
    const [candidate] = await tx
      .select({
        versionId: schema.catalogItemVersions.id,
        kind: schema.catalogItemVersions.kind,
        status: schema.catalogItemVersions.status,
        durationDays: schema.planEntitlements.demoDurationDays,
      })
      .from(schema.catalogItemVersions)
      .leftJoin(
        schema.planEntitlements,
        eq(schema.planEntitlements.catalogVersionId, schema.catalogItemVersions.id),
      )
      .where(eq(schema.catalogItemVersions.id, observed.versionId));
    if (
      !candidate ||
      candidate.kind !== "plan" ||
      candidate.status !== "published" ||
      candidate.durationDays === null ||
      candidate.durationDays <= 0
    ) {
      if (allowUnmanaged) return null;
      throw new ConflictException({ code: "default_demo_not_configured" });
    }
    return { versionId: candidate.versionId, durationDays: candidate.durationDays };
  }

  private async lockDefaultSetting(tx: ProvisionTransaction): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('platform-default-demo-setting', 0))`,
    );
    await tx.execute(sql`select key from platform_settings where key = 'default' for share`);
  }
}
