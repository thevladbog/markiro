import { randomBytes, randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  DEFAULT_BOX_LABEL_TEMPLATE_NAME,
  PALLET_LABEL_TEMPLATE_NAME,
  buildDefaultLabelTemplates,
  buildDuplicateLabelTemplates,
  buildPalletLabelTemplates,
} from "@markiro/domain";
import { DB } from "../../auth/auth.module";
import type { PlatformPrincipal } from "../../platform-auth/platform-access-policy";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { GrantCabinetAccessDto, GrantCabinetAccessResult } from "@markiro/platform-contracts";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import { MailDeliveryService } from "../mail/mail-delivery.service";
import { activationIdentifier } from "../tenant-owner-activation/token";
import { provisionTenantSchema, type ProvisionTenantDto, type ProvisionTenantInput } from "./dto";

export const TENANT_OWNER_ACTIVATION_BASE_URL = "TENANT_OWNER_ACTIVATION_BASE_URL";

type ProvisionTransaction = Parameters<Db["transaction"]>[0] extends (arg: infer T) => unknown
  ? T
  : never;

export interface TenantProvisioningResult {
  tenantId: string;
  userId: string | null;
  memberId: string | null;
  deliveryId: string | null;
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
    rawInput: ProvisionTenantInput,
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
    // A tenant without cabinet has no e-mail and therefore no identity to
    // serialize; it takes the slug lock only.
    if (input.email !== undefined) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-email:${input.email}`}, 0))`,
      );
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-slug:${input.tenantSlug}`}, 0))`,
    );

    let [tenant] = await tx
      .select({ id: schema.organization.id, cabinetAccess: schema.organization.cabinetAccess })
      .from(schema.organization)
      .where(eq(schema.organization.slug, input.tenantSlug))
      .limit(1);
    // An idempotent retry must describe the same tenant; a slug reused with a
    // different cabinet access is a conflict, never a silent switch.
    if (tenant && tenant.cabinetAccess !== input.cabinetAccess) {
      throw new ConflictException({ code: "tenant_cabinet_access_mismatch" });
    }
    const tenantCreated = !tenant;
    // Existing tenants keep their historical managed/unmanaged state. A
    // default demo is required only before the organization insert, never
    // to renew an existing owner's activation or to retry idempotently. A
    // tenant without cabinet gets no subscription and so needs no demo.
    const demo =
      tenant || input.cabinetAccess === "none"
        ? null
        : await this.lockDefaultDemo(tx, options.allowUnmanagedWithoutDemo === true);
    if (!tenant) {
      tenant = { id: createId(), cabinetAccess: input.cabinetAccess };
      await tx.insert(schema.organization).values({
        id: tenant.id,
        name: input.tenantName,
        slug: input.tenantSlug,
        cabinetAccess: input.cabinetAccess,
        createdAt: operationAt,
      });
      await tx
        .insert(schema.pickupTenantPolicies)
        .values({ tenantId: tenant.id, limitsEnabled: false, updatedAt: operationAt });

      // Stock box-label templates (specs 2026-08-20 and 2026-09-10). All
      // families come from the single `buildDefaultLabelTemplates()` list, so
      // a family added there is seeded here without touching this loop. The
      // templates are resolution-neutral — the station prints them at its own
      // printer's dpi — and the tenant's DEFAULT stays the dated 58×40
      // (`DEFAULT_BOX_LABEL_TEMPLATE_NAME`) regardless.
      // Seeded only on tenant CREATION — re-provisioning an existing tenant
      // (idempotent retry) must not duplicate them.
      let defaultBoxLabelTemplateId: string | null = null;
      for (const template of buildDefaultLabelTemplates()) {
        const templateId = createId();
        await tx.insert(schema.labelTemplates).values({
          id: templateId,
          tenantId: tenant.id,
          name: template.name,
          spec: template.spec,
        });
        if (template.name === DEFAULT_BOX_LABEL_TEMPLATE_NAME) {
          defaultBoxLabelTemplateId = templateId;
        }
      }
      if (defaultBoxLabelTemplateId === null) {
        // Programming error, not a user-facing conflict: DEFAULT_BOX_LABEL_TEMPLATE_NAME
        // and buildDefaultLabelTemplates() are independently hardcoded in
        // @markiro/domain. A composite FK with a null column is unenforced
        // (MATCH SIMPLE), so failing to match here would otherwise let
        // org_profiles.default_box_label_template_id insert as null silently.
        throw new Error(
          `No seeded label template matched DEFAULT_BOX_LABEL_TEMPLATE_NAME (${DEFAULT_BOX_LABEL_TEMPLATE_NAME})`,
        );
      }
      for (const { name, spec } of buildDuplicateLabelTemplates()) {
        await tx.insert(schema.labelTemplates).values({
          id: createId(),
          tenantId: tenant.id,
          name,
          purpose: "product_duplicate",
          spec,
        });
      }
      // Stock PALLET label (slice 06d). Its own family for the same reason
      // the duplicate labels are: `purpose` decides which picker offers a
      // template, and a pallet label must never appear where a box label is
      // expected. Migrations 0137 (100x150) and 0164 (58x40) seed the
      // identical rows for tenants that already existed, so both paths leave
      // exactly two stock pallet labels.
      let defaultPalletLabelTemplateId: string | null = null;
      for (const { name, spec } of buildPalletLabelTemplates()) {
        const templateId = createId();
        await tx.insert(schema.labelTemplates).values({
          id: templateId,
          tenantId: tenant.id,
          name,
          purpose: "pallet",
          spec,
        });
        if (name === PALLET_LABEL_TEMPLATE_NAME) defaultPalletLabelTemplateId = templateId;
      }
      if (defaultPalletLabelTemplateId === null) {
        // Programming error, not a user-facing conflict — the same reasoning
        // as the box default above: a composite FK with a null column is
        // unenforced (MATCH SIMPLE), so a failed match would insert null
        // silently and the tenant would quietly have no pallet default.
        throw new Error(
          `No seeded label template matched PALLET_LABEL_TEMPLATE_NAME (${PALLET_LABEL_TEMPLATE_NAME})`,
        );
      }
      await tx.insert(schema.orgProfiles).values({
        tenantId: tenant.id,
        defaultBoxLabelTemplateId,
        defaultPalletLabelTemplateId,
      });
    }

    let owner: { user: { id: string }; memberId: string; deliveryId: string } | null = null;
    if (input.cabinetAccess === "enabled") {
      if (input.email === undefined) throw new Error("cabinet access enabled requires an e-mail");
      owner = await this.provisionOwner(tx, {
        tenantId: tenant.id,
        tenantName: input.tenantName,
        email: input.email,
        operationAt,
        createId,
        createToken,
        options,
      });
    }

    const subscriptionId =
      tenantCreated && demo
        ? await this.insertPendingDemo(tx, {
            tenantId: tenant.id,
            demo,
            operationAt,
            createId,
            actor: options.actor,
          })
        : null;

    if (tenantCreated) {
      // "unmanaged" means a managed tenant created without a default demo; a
      // tenant without cabinet is a different fact and is never reported so.
      const offline = input.cabinetAccess === "none";
      const unmanaged = !offline && demo === null;
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
          cabinetAccess: input.cabinetAccess,
          ownerUserId: owner?.user.id ?? null,
          ownerMemberId: owner?.memberId ?? null,
          subscriptionId,
          subscriptionStatus: offline ? "none" : unmanaged ? "unmanaged" : "pending_activation",
          planVersionId: demo?.versionId ?? null,
        },
        requestId: null,
      });
    }

    return {
      tenantId: tenant.id,
      userId: owner?.user.id ?? null,
      memberId: owner?.memberId ?? null,
      deliveryId: owner?.deliveryId ?? null,
    };
  }

  /**
   * Gives a tenant created without a cabinet its first owner and the default
   * demo, exactly as provisioning gives a new tenant: a `pending_activation`
   * demo subscription that starts when the owner activates. Without a
   * configured default demo the grant fails with `default_demo_not_configured`
   * and changes nothing; a default demo switched mid-grant retries the whole
   * transaction, as provisioning does.
   *
   * Lock order: owner e-mail advisory lock, tenant slug advisory lock, tenant
   * subscription timeline advisory lock, the organization row, then the
   * default demo (candidate catalog version FOR KEY SHARE, then the
   * 'platform-default-demo-setting' advisory lock and the settings row FOR
   * SHARE).
   * - The e-mail then slug prefix is the provisioning order, so a grant and a
   *   provisioning (or activation renewal) of the same e-mail or slug queue
   *   behind each other instead of crossing.
   * - The timeline lock is the first lock every subscription lifecycle path
   *   takes, and none of them takes an e-mail or slug lock, so waiting for it
   *   while holding those cannot close a cycle. Holding it makes the licence
   *   guard (`assertKindAllowedForTenant`) see either `none` or the committed
   *   `enabled`, never a switch between its check and its write, and puts the
   *   demo insert under the same lock as every other timeline write. It is
   *   keyed by tenant id, so two grants for one tenant serialize on it too.
   * - The organization row is taken FOR NO KEY UPDATE, the same strength the
   *   `cabinet_access` update needs anyway. It does not conflict with the
   *   FOR KEY SHARE locks that foreign-key inserts into tenant tables take,
   *   so a path that inserts tenant rows before taking the timeline lock
   *   cannot deadlock against a grant that holds the timeline lock.
   * - The default-demo locks come last. Default selection and retirement take
   *   the catalog version, then the setting, and never a tenant lock;
   *   provisioning takes e-mail, slug, then the same catalog/setting pair and
   *   no tenant lock after it; lifecycle paths never take the setting. So a
   *   holder of the setting lock never waits for a lock the grant took
   *   earlier, and tenant locks are always taken before catalog locks.
   */
  async grantCabinetAccess(
    tenantId: string,
    input: GrantCabinetAccessDto,
    options: {
      actor: PlatformPrincipal;
      now?: () => Date;
      createId?: () => string;
      createToken?: () => string;
    },
  ): Promise<GrantCabinetAccessResult> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.db.transaction((tx) =>
          this.grantCabinetAccessInTransaction(tx, tenantId, input, options),
        );
      } catch (error) {
        if (error instanceof DefaultDemoChanged && attempt < 3) continue;
        throw error;
      }
    }
    throw new ConflictException({ code: "default_demo_changed" });
  }

  private async grantCabinetAccessInTransaction(
    tx: ProvisionTransaction,
    tenantId: string,
    input: GrantCabinetAccessDto,
    options: {
      actor: PlatformPrincipal;
      now?: () => Date;
      createId?: () => string;
      createToken?: () => string;
    },
  ): Promise<GrantCabinetAccessResult> {
    const operationAt = (options.now ?? (() => new Date()))();
    const createId = options.createId ?? randomUUID;
    const createToken = options.createToken ?? (() => randomBytes(24).toString("base64url"));

    const [located] = await tx
      .select({ slug: schema.organization.slug })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId))
      .limit(1);
    if (!located) throw new NotFoundException({ code: "tenant_not_found" });

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-email:${input.email}`}, 0))`,
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`tenant-owner-slug:${located.slug}`}, 0))`,
    );
    await lockTenantSubscriptionTimeline(tx, tenantId);
    const [tenant] = await tx
      .select({
        id: schema.organization.id,
        name: schema.organization.name,
        cabinetAccess: schema.organization.cabinetAccess,
      })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId))
      .for("no key update")
      .limit(1);
    if (!tenant) throw new NotFoundException({ code: "tenant_not_found" });
    if (tenant.cabinetAccess !== "none") {
      throw new ConflictException({ code: "cabinet_access_already_enabled" });
    }
    // Never null: without a default demo this throws before any write.
    const demo = await this.lockDefaultDemo(tx, false);
    if (!demo) throw new ConflictException({ code: "default_demo_not_configured" });

    const owner = await this.provisionOwner(tx, {
      tenantId,
      tenantName: tenant.name,
      email: input.email,
      operationAt,
      createId,
      createToken,
      options: { actor: options.actor },
    });
    await tx
      .update(schema.organization)
      .set({ cabinetAccess: "enabled" })
      .where(eq(schema.organization.id, tenantId));
    // Inserted directly, as provisioning does, not through plan assignment:
    // the licence guard is for operator-assigned licences, and this demo is
    // part of the cabinet being granted.
    const subscriptionId = await this.insertPendingDemo(tx, {
      tenantId,
      demo,
      operationAt,
      createId,
      actor: options.actor,
    });
    await this.audit.record(tx, {
      actorPlatformUserId: options.actor.userId,
      actorRole: options.actor.role,
      action: "platform.tenant.cabinet_access.granted",
      outcome: "success",
      tenantId,
      targetType: "member",
      targetId: owner.memberId,
      reason: null,
      before: { cabinetAccess: "none" },
      after: {
        cabinetAccess: "enabled",
        ownerUserId: owner.user.id,
        deliveryId: owner.deliveryId,
        subscriptionId,
        subscriptionStatus: "pending_activation",
        planVersionId: demo.versionId,
      },
      requestId: null,
    });
    return {
      tenantId,
      userId: owner.user.id,
      memberId: owner.memberId,
      deliveryId: owner.deliveryId,
    };
  }

  /**
   * The default demo as every new cabinet gets it: a `pending_activation`
   * subscription with no dates, activated with the owner. The caller holds
   * the default-demo locks (`lockDefaultDemo`).
   */
  private async insertPendingDemo(
    tx: ProvisionTransaction,
    ctx: {
      tenantId: string;
      demo: DefaultDemo;
      operationAt: Date;
      createId: () => string;
      actor: PlatformPrincipal | undefined;
    },
  ): Promise<string> {
    const { tenantId, demo, operationAt, actor } = ctx;
    const subscriptionId = ctx.createId();
    await tx.insert(schema.tenantSubscriptions).values({
      id: subscriptionId,
      tenantId,
      planVersionId: demo.versionId,
      status: "pending_activation",
      startsAt: null,
      endsAt: null,
      source: "demo",
      createdByPlatformUserId: actor?.userId ?? null,
      createdAt: operationAt,
      updatedAt: operationAt,
    });
    await tx.insert(schema.subscriptionEvents).values({
      tenantId,
      subscriptionId,
      eventKind: "demo.provisioned",
      effectiveAt: operationAt,
      actorPlatformUserId: actor?.userId ?? null,
      source: actor ? "platform" : "cli",
      reason: null,
      before: null,
      after: {
        status: "pending_activation",
        planVersionId: demo.versionId,
        demoDurationDays: demo.durationDays,
      },
    });
    return subscriptionId;
  }

  private async provisionOwner(
    tx: ProvisionTransaction,
    ctx: {
      tenantId: string;
      tenantName: string;
      email: string;
      operationAt: Date;
      createId: () => string;
      createToken: () => string;
      options: TenantProvisioningOptions;
    },
  ): Promise<{
    user: { id: string; emailVerified: boolean };
    memberId: string;
    deliveryId: string;
  }> {
    const { tenantId, tenantName, email, operationAt, createId, createToken, options } = ctx;
    let [user] = await tx
      .select({ id: schema.user.id, emailVerified: schema.user.emailVerified })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);
    if (!user) {
      user = { id: createId(), emailVerified: false };
      await tx.insert(schema.user).values({
        id: user.id,
        email: email,
        name: email,
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
      .where(eq(schema.member.organizationId, tenantId));
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
        organizationId: tenantId,
        userId: user.id,
        role: "owner",
        createdAt: operationAt,
      });
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: null,
        action: "tenant.owner.provisioned",
        outcome: "success",
        targetType: "member",
        targetId: memberId,
      });
    }

    const sourceId = `tenant-owner:${tenantId}`;
    const subjectValue = JSON.stringify({ userId: user.id, tenantId });
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
        recipient: email,
        sourceId,
        template: {
          kind: "tenant-owner-activation",
          recipientName: "Пользователь",
          organizationName: tenantName,
          actionUrl: actionUrl.toString(),
          expiresInMinutes: 60,
        },
      });
      if (options.renewActivation && existingDelivery) {
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
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
            tenantId,
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

    if (!deliveryId) throw new Error("tenant owner activation delivery missing");
    return { user, memberId, deliveryId };
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
