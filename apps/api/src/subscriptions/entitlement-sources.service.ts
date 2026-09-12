import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  ENTITLEMENT_OPERATIONS,
  P1_FEATURE_KEYS,
  entitlementSourcePreviewRequestSchema,
  entitlementSourceConfirmSchema,
  entitlementSourcePreviewSchema,
  entitlementSourceConfirmationSchema,
  entitlementSnapshotV1Schema,
  entitlementSourceListSchema,
  entitlementImpactSchema,
  platformTenantIdSchema,
  type PlatformPrincipal,
  type PlatformCapability,
  type EntitlementSourcePreviewRequest,
  type EntitlementSourceConfirm,
  type EntitlementSourcePreview,
  type EntitlementSourceConfirmation,
  type EntitlementSourceList,
  type EntitlementImpact,
  type EntitlementOperationId,
} from "@markiro/platform-contracts";
import { DB } from "../auth/auth.module";
import { PlatformAuditService } from "../platform-auth/platform-audit.service";
import { platformCapabilitiesForRole } from "../platform-auth/platform-access-policy";
import { EntitlementsService } from "./entitlements.service";
import { QUANTITATIVE_ENTITLEMENT_KEYS, type SubscriptionTransaction } from "./entitlements.types";
import { lockTenantSubscriptionTimeline } from "./subscription-locks";
import {
  entitlementDigest,
  entitlementRegistryFingerprint,
  platformSource,
  safeSource,
} from "./entitlement-snapshot-reader";
import { evaluateEntitlementOperation, projectEntitlements } from "./entitlement-projection";

type PreviewRow = typeof schema.entitlementSourcePreviews.$inferSelect;
type Facts = Awaited<ReturnType<EntitlementsService["resolveSnapshotInTransaction"]>>;
// Technical review validity only; this is not an offline/commercial grace period.
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const conflict = () => new ConflictException({ code: "entitlement_request_conflict" });
const stale = () =>
  new ConflictException({ code: "entitlement_preview_stale", newRequestIdRequired: true });

@Injectable()
export class EntitlementSourcesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
  ) {}

  async preview(
    principal: PlatformPrincipal,
    tenantId: string,
    input: EntitlementSourcePreviewRequest,
  ): Promise<EntitlementSourcePreview> {
    this.validateTenant(tenantId);
    const parsed = entitlementSourcePreviewRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "entitlement_source_invalid" });
    const request = parsed.data;
    const requestId = request.intent === "prepare" ? request.command.requestId : request.requestId;
    const payloadHash = entitlementDigest(request);
    return this.transaction(async (tx) => {
      await this.lock(tx, tenantId);
      const actor = await this.requireActor(
        tx,
        principal,
        ["tenants.write", "billing.write"],
        true,
      );
      await this.requireTenant(tx, tenantId);
      const [existing] = await tx
        .select()
        .from(schema.entitlementSourcePreviews)
        .where(
          and(
            eq(schema.entitlementSourcePreviews.tenantId, tenantId),
            eq(schema.entitlementSourcePreviews.requestId, requestId),
          ),
        )
        .for("update");
      if (existing && existing.createdByPlatformUserId !== actor.id) throw new ForbiddenException();
      if (
        existing &&
        (existing.payloadHash !== payloadHash ||
          entitlementDigest(existing.payload) !== payloadHash)
      )
        throw conflict();
      const facts = await this.entitlements.resolveSnapshotInTransaction(tenantId, tx);
      if (existing) {
        if (!existing.confirmedAt) this.assertFresh(existing, facts);
        else await this.validateResult(tx, existing);
        return this.previewResponse(existing);
      }
      let subscriptionId: string;
      const previewId = randomUUID();
      let afterSources: Facts["sources"];
      if (request.intent === "prepare") {
        if (facts.snapshot.current.access !== "managed" || !facts.snapshot.current.subscription)
          throw new ConflictException({ code: "entitlement_base_required" });
        subscriptionId = facts.snapshot.current.subscription.id;
        const command = request.command;
        // Source may extend beyond the base; projection always remains base-gated.
        if (command.endsAt !== null && Date.parse(command.endsAt) <= facts.input.at.getTime())
          throw stale();
        const source = safeSource(
          platformSource({
            id: previewId,
            versionId: previewId,
            tenantId,
            subscriptionId,
            kind: command.kind,
            version: 1,
            effects: command.effects,
            operationIds: command.operationIds,
            startsAt: new Date(command.startsAt),
            endsAt: command.endsAt === null ? null : new Date(command.endsAt),
            prepared: true,
            reason: command.reason,
            decisionReference: command.decisionReference,
            requestId,
            createdByPlatformUserId: actor.id,
            createdAt: facts.input.at,
            revokedAt: null,
            revokedByPlatformUserId: null,
            revocationReason: null,
            revocationDecisionReference: null,
            revocationRequestId: null,
          }),
        );
        afterSources = [...facts.sources, source];
      } else {
        const source = facts.sourceDetails.find((source) => source.id === request.sourceId);
        if (!source) throw new NotFoundException();
        if (source.revokedAt !== null) throw conflict();
        subscriptionId = source.subscriptionId;
        afterSources = facts.sources.filter((source) => source.id !== request.sourceId);
      }
      const after = projectEntitlements({ ...facts.input, sources: afterSources });
      const boundary = [facts.snapshot.nextChangeAt, after.nextChangeAt]
        .filter((value): value is string => value !== null)
        .sort()[0];
      const expiresAt = new Date(
        Math.min(
          facts.input.at.getTime() + PREVIEW_TTL_MS,
          boundary ? Date.parse(boundary) : Infinity,
        ),
      );
      // Revision lock last: an intervening committed usage/terms write causes 40001,
      // retrying this entire transaction instead of accepting a stale snapshot.
      await this.lockReferencedFacts(tx, facts);
      await this.lockRevision(tx, tenantId);
      const [row] = await tx
        .insert(schema.entitlementSourcePreviews)
        .values({
          id: previewId,
          tenantId,
          subscriptionId,
          intent: request.intent,
          requestId,
          createdByPlatformUserId: actor.id,
          payload: request,
          payloadHash,
          revision: BigInt(facts.revision),
          usageRevision: BigInt(facts.usageRevision),
          usageFingerprint: facts.usageFingerprint,
          registryVersion: entitlementRegistryFingerprint(),
          lifecyclePolicyFingerprint: facts.policyFingerprint,
          nextChangeAt: boundary ? new Date(boundary) : null,
          beforeSnapshot: facts.snapshot,
          afterSnapshot: after,
          createdAt: facts.input.at,
          expiresAt,
        })
        .returning();
      if (!row) throw new Error("Entitlement preview insert returned no row");
      return this.previewResponse(row);
    });
  }

  async confirm(
    principal: PlatformPrincipal,
    tenantId: string,
    input: EntitlementSourceConfirm,
  ): Promise<EntitlementSourceConfirmation> {
    this.validateTenant(tenantId);
    const parsed = entitlementSourceConfirmSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException({ code: "entitlement_confirmation_invalid" });
    return this.transaction(async (tx) => {
      await this.lock(tx, tenantId);
      const actor = await this.requireActor(
        tx,
        principal,
        ["tenants.write", "billing.write"],
        true,
      );
      const [preview] = await tx
        .select()
        .from(schema.entitlementSourcePreviews)
        .where(
          and(
            eq(schema.entitlementSourcePreviews.tenantId, tenantId),
            eq(schema.entitlementSourcePreviews.id, parsed.data.previewId),
          ),
        )
        .for("update");
      if (!preview) throw new NotFoundException();
      if (preview.createdByPlatformUserId !== actor.id) throw new ForbiddenException();
      if (preview.requestId !== parsed.data.requestId) throw conflict();
      const request = this.validatedPayload(preview);
      if (preview.confirmedAt) {
        await this.validateResult(tx, preview);
        return this.confirmationResponse(preview);
      }
      const facts = await this.entitlements.resolveSnapshotInTransaction(tenantId, tx);
      this.assertFresh(preview, facts);
      let sourceId = preview.id;
      let versionId = preview.id;
      let version = 1;
      let before: Record<string, unknown> | null = null;
      if (request.intent === "revoke") {
        sourceId = request.sourceId;
        const [source] = await tx
          .select()
          .from(schema.entitlementSources)
          .where(
            and(
              eq(schema.entitlementSources.tenantId, tenantId),
              eq(schema.entitlementSources.id, sourceId),
              eq(schema.entitlementSources.subscriptionId, preview.subscriptionId),
            ),
          )
          .for("update");
        if (!source || source.revokedAt !== null) throw conflict();
        versionId = source.versionId;
        version = source.version;
        before = {
          sourceId,
          versionId: source.versionId,
          version: source.version,
          effects: source.effects,
          operationIds: source.operationIds,
          startsAt: source.startsAt.toISOString(),
          endsAt: source.endsAt?.toISOString() ?? null,
        };
      }
      await this.lockReferencedFacts(tx, facts);
      await this.lockRevision(tx, tenantId);
      // Recheck wall time after waits; the projection timestamp is never fresh admission authority.
      const confirmedAt = new Date();
      if (confirmedAt >= preview.expiresAt) throw stale();
      if (request.intent === "prepare") {
        const command = request.command;
        await tx.insert(schema.entitlementSources).values({
          id: sourceId,
          versionId: sourceId,
          tenantId,
          subscriptionId: preview.subscriptionId,
          kind: command.kind,
          effects: command.effects,
          operationIds: command.operationIds,
          startsAt: new Date(command.startsAt),
          endsAt: command.endsAt === null ? null : new Date(command.endsAt),
          reason: command.reason,
          decisionReference: command.decisionReference,
          requestId: command.requestId,
          createdByPlatformUserId: actor.id,
          createdAt: confirmedAt,
        });
      } else {
        await tx
          .update(schema.entitlementSources)
          .set({
            revokedAt: confirmedAt,
            revokedByPlatformUserId: actor.id,
            revocationReason: request.reason,
            revocationDecisionReference: request.decisionReference,
            revocationRequestId: request.requestId,
          })
          .where(
            and(
              eq(schema.entitlementSources.tenantId, tenantId),
              eq(schema.entitlementSources.id, sourceId),
              eq(schema.entitlementSources.subscriptionId, preview.subscriptionId),
            ),
          );
      }
      const [confirmed] = await tx
        .update(schema.entitlementSourcePreviews)
        .set({ confirmedAt, resultSourceId: sourceId })
        .where(eq(schema.entitlementSourcePreviews.id, preview.id))
        .returning();
      if (!confirmed) throw new Error("Entitlement confirmation returned no row");
      await this.validateResult(tx, confirmed);
      const details = request.intent === "prepare" ? request.command : request;
      await this.audit.record(tx, {
        actorPlatformUserId: actor.id,
        actorRole: actor.role,
        action:
          request.intent === "prepare"
            ? "entitlement_source.prepared"
            : "entitlement_source.revoked",
        outcome: "success",
        tenantId,
        targetType: "entitlement_source",
        targetId: sourceId,
        reason: details.reason,
        requestId: preview.requestId,
        before,
        after: {
          sourceId,
          versionId,
          version,
          subscriptionId: preview.subscriptionId,
          previewId: preview.id,
          payloadHash: preview.payloadHash,
          revision: preview.revision.toString(),
          usageRevision: preview.usageRevision.toString(),
          registryVersion: preview.registryVersion,
          decisionReference: details.decisionReference,
          ...(request.intent === "prepare"
            ? {
                effects: request.command.effects,
                operationIds: request.command.operationIds,
                startsAt: request.command.startsAt,
                endsAt: request.command.endsAt,
                prepared: true,
              }
            : { revokedAt: confirmedAt.toISOString() }),
        },
      });
      return this.confirmationResponse(confirmed);
    });
  }

  async list(principal: PlatformPrincipal, tenantId: string): Promise<EntitlementSourceList> {
    this.validateTenant(tenantId);
    const result = await this.db.transaction(
      async (tx) => {
        const actor = await this.requireActor(tx, principal, ["tenants.read"]);
        await this.requireTenant(tx, tenantId);
        const facts = await this.entitlements.resolveSnapshotInTransaction(tenantId, tx);
        const detailsVisible = platformCapabilitiesForRole(actor.role).includes("billing.read");
        return {
          snapshot: facts.snapshot,
          detailsVisible,
          sourceDetails: detailsVisible ? facts.sourceDetails : [],
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    return entitlementSourceListSchema.parse({
      ...result,
      snapshot: await this.entitlements.observeConnectivity(result.snapshot),
    });
  }

  async impact(principal: PlatformPrincipal, tenantId: string): Promise<EntitlementImpact> {
    const { snapshot } = await this.list(principal, tenantId);
    const operations = (Object.keys(ENTITLEMENT_OPERATIONS) as EntitlementOperationId[]).map(
      (operationId) => ({ operationId, ...evaluateEntitlementOperation(snapshot, operationId) }),
    );
    const commercialV3Required = snapshot.sources.some(
      (source) =>
        source.prepared ||
        (source.kind === "plan"
          ? P1_FEATURE_KEYS.some((key) => source.plan.features[key] !== null)
          : source.effects.some((effect) =>
              (P1_FEATURE_KEYS as readonly string[]).includes(effect.key),
            )),
    );
    return entitlementImpactSchema.parse({
      tenantId,
      observedAt: snapshot.asOf,
      scope: "tenant_current_observation",
      mode: "shadow",
      reasons: [
        ...new Set([
          ...snapshot.readiness.reasons,
          ...(commercialV3Required ? ["commercial_v3_required"] : []),
          "native_p1_unverified",
          ...operations.flatMap((operation) => operation.reasonCodes),
        ]),
      ].sort(),
      operations,
      clientRepresentation: { commercialV3Required, nativeP1Verified: false },
    });
  }

  private validatedPayload(preview: PreviewRow): EntitlementSourcePreviewRequest {
    const result = entitlementSourcePreviewRequestSchema.safeParse(preview.payload);
    if (
      !result.success ||
      entitlementDigest(result.data) !== preview.payloadHash ||
      result.data.intent !== preview.intent ||
      (result.data.intent === "prepare" ? result.data.command.requestId : result.data.requestId) !==
        preview.requestId
    )
      throw conflict();
    const before = entitlementSnapshotV1Schema.safeParse(preview.beforeSnapshot);
    const after = entitlementSnapshotV1Schema.safeParse(preview.afterSnapshot);
    if (
      !before.success ||
      !after.success ||
      before.data.tenantId !== preview.tenantId ||
      after.data.tenantId !== preview.tenantId ||
      entitlementDigest(before.data.current) !== entitlementDigest(after.data.current) ||
      (result.data.intent === "prepare" &&
        before.data.current.subscription?.id !== preview.subscriptionId)
    )
      throw conflict();
    return result.data;
  }
  private assertFresh(preview: PreviewRow, facts: Facts) {
    this.validatedPayload(preview);
    const before = entitlementSnapshotV1Schema.parse(preview.beforeSnapshot);
    if (
      preview.expiresAt <= new Date() ||
      preview.revision.toString() !== facts.revision ||
      preview.usageRevision.toString() !== facts.usageRevision ||
      preview.usageFingerprint !== facts.usageFingerprint ||
      preview.registryVersion !== entitlementRegistryFingerprint() ||
      preview.lifecyclePolicyFingerprint !== facts.policyFingerprint ||
      entitlementDigest(before.current) !== entitlementDigest(facts.snapshot.current)
    )
      throw stale();
  }
  private async validateResult(tx: SubscriptionTransaction, preview: PreviewRow) {
    const request = this.validatedPayload(preview);
    const [source] = await tx
      .select()
      .from(schema.entitlementSources)
      .where(
        and(
          eq(schema.entitlementSources.tenantId, preview.tenantId),
          eq(schema.entitlementSources.id, preview.resultSourceId ?? preview.id),
          eq(schema.entitlementSources.subscriptionId, preview.subscriptionId),
        ),
      );
    if (!source) throw conflict();
    if (request.intent === "prepare") {
      const persisted = platformSource(source);
      const command = {
        kind: persisted.kind,
        effects: persisted.effects,
        operationIds: persisted.operationIds,
        startsAt: persisted.startsAt,
        endsAt: persisted.endsAt,
        reason: persisted.reason,
        decisionReference: persisted.decisionReference,
        requestId: persisted.requestId,
      };
      if (
        source.id !== preview.id ||
        source.versionId !== preview.id ||
        source.createdByPlatformUserId !== preview.createdByPlatformUserId ||
        entitlementDigest({ intent: "prepare", command }) !== preview.payloadHash
      )
        throw conflict();
      const after = entitlementSnapshotV1Schema.parse(preview.afterSnapshot);
      const expected = after.sources.find((item) => item.id === source.id);
      if (!expected || entitlementDigest(expected) !== entitlementDigest(safeSource(persisted)))
        throw conflict();
    } else if (
      source.id !== request.sourceId ||
      source.revocationRequestId !== request.requestId ||
      source.revokedByPlatformUserId !== preview.createdByPlatformUserId ||
      source.revocationReason !== request.reason ||
      source.revocationDecisionReference !== request.decisionReference ||
      source.revokedAt?.getTime() !== preview.confirmedAt?.getTime()
    )
      throw conflict();
  }
  private previewResponse(row: PreviewRow): EntitlementSourcePreview {
    return entitlementSourcePreviewSchema.parse({
      previewId: row.id,
      requestId: row.requestId,
      intent: row.intent,
      revision: row.revision.toString(),
      usageRevision: row.usageRevision.toString(),
      expiresAt: row.expiresAt.toISOString(),
      before: row.beforeSnapshot,
      after: row.afterSnapshot,
    });
  }
  private confirmationResponse(row: PreviewRow): EntitlementSourceConfirmation {
    return entitlementSourceConfirmationSchema.parse({
      previewId: row.id,
      requestId: row.requestId,
      sourceId: row.resultSourceId,
      confirmedAt: row.confirmedAt?.toISOString(),
      after: row.afterSnapshot,
    });
  }
  private validateTenant(tenantId: string) {
    if (!platformTenantIdSchema.safeParse(tenantId).success)
      throw new BadRequestException({ code: "tenant_id_invalid" });
  }
  private async requireTenant(tx: SubscriptionTransaction, tenantId: string) {
    const [tenant] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantId));
    if (!tenant) throw new NotFoundException();
  }
  private async requireActor(
    tx: SubscriptionTransaction,
    principal: PlatformPrincipal,
    required: PlatformCapability[],
    lock = false,
  ) {
    if (!principal || typeof principal.userId !== "string" || !principal.twoFactorReady)
      throw new ForbiddenException();
    const query = tx
      .select()
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, principal.userId));
    const [actor] = await (lock ? query.for("share") : query);
    if (
      !actor ||
      actor.status !== "active" ||
      !actor.twoFactorEnabled ||
      !required.every((cap) => platformCapabilitiesForRole(actor.role).includes(cap))
    )
      throw new ForbiddenException();
    const factorQuery = tx
      .select({ id: schema.platformTwoFactors.id })
      .from(schema.platformTwoFactors)
      .where(
        and(
          eq(schema.platformTwoFactors.userId, actor.id),
          eq(schema.platformTwoFactors.verified, true),
        ),
      );
    const [factor] = await (lock ? factorQuery.for("share") : factorQuery);
    if (!factor) throw new ForbiddenException();
    return actor;
  }
  private async lock(tx: SubscriptionTransaction, tenantId: string) {
    for (const key of QUANTITATIVE_ENTITLEMENT_KEYS)
      await this.entitlements.withQuotaLock(tx, tenantId, key, () => Promise.resolve(undefined));
    await lockTenantSubscriptionTimeline(tx, tenantId);
    await tx
      .select({ id: schema.tenantSubscriptions.id })
      .from(schema.tenantSubscriptions)
      .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
      .orderBy(asc(schema.tenantSubscriptions.id))
      .for("update");
  }
  private async lockReferencedFacts(tx: SubscriptionTransaction, facts: Facts) {
    if (facts.versionIds.length)
      await tx
        .select({ id: schema.catalogItemVersions.id })
        .from(schema.catalogItemVersions)
        .where(inArray(schema.catalogItemVersions.id, facts.versionIds))
        .orderBy(asc(schema.catalogItemVersions.id))
        .for("share");
    if (facts.policyIds.length)
      await tx
        .select({ id: schema.entitlementLifecyclePolicies.id })
        .from(schema.entitlementLifecyclePolicies)
        .where(inArray(schema.entitlementLifecyclePolicies.id, facts.policyIds))
        .orderBy(asc(schema.entitlementLifecyclePolicies.id))
        .for("share");
  }
  private async lockRevision(tx: SubscriptionTransaction, tenantId: string) {
    await tx.execute(
      sql`select tenant_id from entitlement_revisions where tenant_id = ${tenantId} for update`,
    );
  }
  private async transaction<T>(action: (tx: SubscriptionTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.transaction(action, { isolationLevel: "repeatable read" });
      } catch (error) {
        let cursor: unknown = error;
        let retryable = false;
        for (let depth = 0; depth < 5 && cursor && typeof cursor === "object"; depth++) {
          if ("code" in cursor && cursor.code === "40001") retryable = true;
          // A concurrent preview insert does not bump terms revision. Repeatable read
          // can therefore reach this one unique constraint with an older snapshot.
          // Restart, then compare the winner's exact actor and payload before replay.
          if (
            "code" in cursor &&
            cursor.code === "23505" &&
            "constraint" in cursor &&
            cursor.constraint === "entitlement_previews_tenant_request_uq"
          )
            retryable = true;
          cursor = "cause" in cursor ? cursor.cause : null;
        }
        if (!retryable || attempt >= 2) throw error;
      }
    }
  }
}
