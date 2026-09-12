import {
  type EntitlementAdmissionService,
  admissionScopeDigest,
} from "../../subscriptions/entitlement-admission.service";
import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { CABINET_CAPABILITY, isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import { ForbiddenException, NotFoundException, HttpException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { AuthorizationService } from "../../authorization/authorization.service";
import type { EntitlementsService } from "../../subscriptions/entitlements.service";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import { chzSignerSettingsSchema } from "../integrations/channel-registry";
import { downloadBoundedImage } from "../media/bounded-image-download";
import { processProductImage } from "../media/product-image-processor";
import type { DbTx, ImportActor } from "./national-catalog-import.types";
import type { NationalCatalogClient } from "./national-catalog.client";
import {
  CatalogRequestError,
  nextRetryAt,
  type NationalCatalogRequestCoordinator,
} from "./national-catalog-request-coordinator";
import {
  newRefreshCheckpoint,
  readRefreshCheckpoint,
  safeRefreshErrorCode,
  type RefreshActor,
  type RefreshCheckpoint,
} from "./national-catalog-refresh-state";
import {
  observeCatalogProjection,
  readCatalogProjection,
  catalogProjectionHash,
} from "./national-catalog-observation-projection";
import { photoReviewSchema } from "./national-catalog-image-state";
import type { CatalogImagePolicy } from "./national-catalog-image.service";
import { photoSelector, selectObservedPhoto } from "./national-catalog-photo-selection";
import { sourceEnvelopeSchema } from "./national-catalog-import-apply-state";
import { canonicalJsonHash } from "./national-catalog-products.service";
import { statuses } from "./national-catalog-enumeration";
import type { NationalCatalogProduct } from "./national-catalog.types";
const links = schema.nationalCatalogProductLinks;
type Link = typeof links.$inferSelect;
const scoped = (tenantId: string, linkId: string) =>
  and(eq(links.tenantId, tenantId), eq(links.id, linkId));
const storedImageSchema = z
  .object({
    sourceId: z.string(),
    url: z.string(),
    barcode: z.string().nullable(),
    primary: z.boolean(),
  })
  .strict();
export type CatalogRefreshPolicy = { enabled: boolean; photos: CatalogImagePolicy };
/** Internal durable worker. Task11 supplies config/DI/queue delivery; no network on request/read. */
export class NationalCatalogLinkRefreshService {
  constructor(
    private readonly db: Db,
    private readonly authorization: AuthorizationService,
    private readonly entitlements: EntitlementsService,
    private readonly client: Pick<NationalCatalogClient, "getFeedProductsByIds">,
    private readonly coordinator: Pick<NationalCatalogRequestCoordinator, "run" | "runExternal">,
    private readonly policy: CatalogRefreshPolicy,
    private readonly download = downloadBoundedImage,
    private readonly admission?: EntitlementAdmissionService,
  ) {}
  async request(actor: ImportActor, productId: string): Promise<void> {
    await this.enqueue(actor.tenantId, productId, { kind: "manual", userId: actor.userId });
  }
  /** Trusted in-process scheduler only; never derive an actor from confirmedBy. */
  async schedule(tenantId: string, productId: string): Promise<void> {
    await this.enqueue(tenantId, productId, { kind: "system" });
  }
  private async enqueue(tenantId: string, productId: string, actor: RefreshActor): Promise<void> {
    const facts = await this.admission?.capture(tenantId);
    await this.db.transaction(async (tx) => {
      await lockTenantSubscriptionTimeline(tx, tenantId);
      const [product] = await tx
        .select()
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, productId)))
        .for("update");
      if (!product) throw new NotFoundException("product_not_found");
      const [link] = await tx
        .select()
        .from(links)
        .where(
          and(eq(links.tenantId, tenantId), eq(links.productId, productId), isNull(links.closedAt)),
        )
        .for("update");
      if (!link) throw new NotFoundException("national_catalog_link_not_found");
      await this.authorize(tx, tenantId, actor, link.environment);
      const previous = readRefreshCheckpoint(link.refreshCheckpoint);
      if (previous?.enqueuePending) return;
      const cp = newRefreshCheckpoint(
        {
          linkId: link.id,
          revision: link.revision,
          cardId: link.cardId,
          environment: link.environment,
          boundGtin14: link.boundGtin14,
        },
        actor,
      );
      if (product.gtin14 !== link.boundGtin14 || product.archived) {
        await this.fail(tx, link, cp, "local_gtin_changed");
        return;
      }
      await this.admission?.observe({
        tenantId: tenantId,
        actor: {
          domain: actor.kind === "manual" ? "cabinet" : "system",
          id: actor.kind === "manual" ? actor.userId : null,
        },
        operationId: "nk.refresh.v1",
        scopeDigest: admissionScopeDigest({
          productId,
          linkId: link.id,
          revision: link.revision,
          stepId: cp.stepId,
        }),
        transaction: tx,
        facts,
        runtime: { enabled: this.policy.enabled, observedAt: new Date() },
      });
      await tx
        .update(links)
        .set({ refreshCheckpoint: cp, refreshErrorCode: null, updatedAt: new Date() })
        .where(scoped(tenantId, link.id));
    });
  }
  /** One actual card or photo step per call. Repairs use persisted stepId and nextRetryAt. */
  async resume(tenantId: string, linkId: string, expectedStepId?: string): Promise<void> {
    const claim = await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, linkId);
      if (!locked) return null;
      const { link, product } = locked;
      const cp = readRefreshCheckpoint(link.refreshCheckpoint);
      if (
        !cp?.enqueuePending ||
        (expectedStepId && cp.stepId !== expectedStepId) ||
        (cp.nextRetryAt && Date.parse(cp.nextRetryAt) > Date.now())
      )
        return null;
      if (!this.identity(link, cp) || link.closedAt) return null;
      if (!(await this.allowed(tx, link, cp, product))) return null;
      if (cp.attempts >= 4) {
        await this.fail(tx, link, cp, "retry_exhausted");
        return null;
      }
      const next = {
        ...cp,
        runId: randomUUID(),
        nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      };
      await tx.update(links).set({ refreshCheckpoint: next }).where(scoped(tenantId, linkId));
      return { link, cp: next };
    });
    if (!claim) return;
    const context = { tenantId, environment: claim.link.environment };
    try {
      if (claim.cp.phase === "card") {
        const result = await this.coordinator.run(
          context,
          async (transport) => {
            if (!(await this.admit(tenantId, linkId, claim.cp)))
              throw new CatalogRequestError("blocked", "access_changed");
            return this.client.getFeedProductsByIds(transport.auth, [claim.link.cardId], transport);
          },
          { attempt: claim.cp.attempts },
        );
        if (result.status !== "ok") throw new CatalogRequestError("failed", "provider_unavailable");
        const matching = result.value.products.filter((p) => String(p.id) === claim.link.cardId);
        const source = matching.length === 1 ? matching[0] : undefined;
        if (!source) throw new CatalogRequestError("failed", "card_unavailable");
        if (
          !source.identifiers.some(
            (i) => isValidGtin(i.value) && normalizeToGtin14(i.value) === claim.link.boundGtin14,
          )
        )
          throw new CatalogRequestError("failed", "card_lost_gtin");
        await this.saveCard(tenantId, linkId, claim.cp, source);
      } else if (claim.cp.phase === "photo") {
        const bytes = await this.coordinator.runExternal(
          context,
          async (signal) => {
            const url = await this.admit(tenantId, linkId, claim.cp, true);
            if (typeof url !== "string") throw new CatalogRequestError("blocked", "access_changed");
            return this.download(
              url,
              {
                maxBytes: 5 * 1024 * 1024,
                timeoutMs: 15_000,
                maxRedirects: 2,
                allowedHosts: this.policy.photos.verifiedHosts,
              },
              { signal },
            );
          },
          { attempt: claim.cp.attempts },
        );
        const processed = await processProductImage(bytes);
        await this.savePhoto(tenantId, linkId, claim.cp, processed.checksum);
      }
    } catch (error) {
      await this.failed(tenantId, linkId, claim.cp, error);
    }
  }
  private async lock(tx: DbTx, tenantId: string, linkId: string) {
    await lockTenantSubscriptionTimeline(tx, tenantId);
    const [hint] = await tx
      .select({ productId: links.productId })
      .from(links)
      .where(scoped(tenantId, linkId));
    if (!hint) return null;
    const [product] = await tx
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.id, hint.productId)))
      .for("update");
    const [link] = await tx.select().from(links).where(scoped(tenantId, linkId)).for("update");
    return product && link ? { product, link } : null;
  }
  private identity(link: Link, cp: RefreshCheckpoint): boolean {
    return (
      link.id === cp.linkId &&
      link.revision === cp.revision &&
      link.cardId === cp.cardId &&
      link.environment === cp.environment &&
      link.boundGtin14 === cp.boundGtin14
    );
  }
  private current(link: Link, expected: RefreshCheckpoint): RefreshCheckpoint | null {
    const cp = readRefreshCheckpoint(link.refreshCheckpoint);
    return !link.closedAt &&
      this.identity(link, expected) &&
      cp?.enqueuePending &&
      cp.stepId === expected.stepId &&
      cp.runId === expected.runId &&
      (cp.phase !== "photo" || link.latestSnapshotId === cp.photo?.snapshotId)
      ? cp
      : null;
  }
  private async authorize(
    tx: DbTx,
    tenantId: string,
    actor: RefreshActor,
    environment: Link["environment"],
  ) {
    if (!this.policy.enabled) throw new ForbiddenException("refresh_disabled");
    if (actor.kind === "manual") {
      const principal = await this.authorization.resolvePrincipal(actor.userId, tenantId, tx);
      if (!principal?.capabilities.includes(CABINET_CAPABILITY.OPERATIONS_WRITE))
        throw new ForbiddenException("access_changed");
    }
    await this.entitlements.assertWriteAccess(tenantId, tx);
    const [channel] = await tx
      .select({ settings: schema.integrationChannels.settings })
      .from(schema.integrationChannels)
      .where(
        and(
          eq(schema.integrationChannels.tenantId, tenantId),
          eq(schema.integrationChannels.type, "chestny_znak"),
        ),
      )
      .for("share");
    const settings = chzSignerSettingsSchema.safeParse(channel?.settings);
    if (!settings.success) throw new ForbiddenException("integration_unconfigured");
    if (settings.data.environment !== environment)
      throw new ForbiddenException("environment_mismatch");
  }
  private async allowed(
    tx: DbTx,
    link: Link,
    cp: RefreshCheckpoint,
    product: typeof schema.products.$inferSelect,
  ): Promise<boolean> {
    if (product.gtin14 !== link.boundGtin14 || product.archived) {
      await this.fail(tx, link, cp, "local_gtin_changed");
      return false;
    }
    try {
      await this.authorize(tx, link.tenantId, cp.actor, link.environment);
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
      await this.fail(
        tx,
        link,
        cp,
        safeRefreshErrorCode(error.message) === "request_failed" ? "access_changed" : error.message,
      );
      return false;
    }
    if (
      cp.phase === "photo" &&
      (!this.policy.photos.enabled || !this.policy.photos.verifiedHosts.length)
    ) {
      await this.fail(tx, link, cp, "photo_unavailable");
      return false;
    }
    return true;
  }
  private async admit(
    tenantId: string,
    linkId: string,
    expected: RefreshCheckpoint,
    photo = false,
  ): Promise<boolean | string> {
    const facts = await this.admission?.capture(tenantId);
    return this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, linkId);
      if (!locked) return false;
      const { link, product } = locked;
      const cp = this.current(link, expected);
      if (!cp || !(await this.allowed(tx, link, cp, product))) return false;
      if (cp.attempts >= 4) {
        await this.fail(tx, link, cp, "retry_exhausted");
        return false;
      }
      const url = photo ? await this.photoUrl(tx, link, cp) : null;
      if (photo && !url) {
        await this.fail(tx, link, cp, "photo_unavailable");
        return false;
      }
      await this.admission?.observe({
        tenantId: tenantId,
        actor: {
          domain: cp.actor.kind === "manual" ? "cabinet" : "system",
          id: cp.actor.kind === "manual" ? cp.actor.userId : null,
        },
        operationId: "nk.worker.v1",
        scopeDigest: admissionScopeDigest({
          linkId,
          revision: cp.revision,
          phase: cp.phase,
          stepId: cp.stepId,
        }),
        transaction: tx,
        facts,
        runtime: { enabled: this.policy.enabled, observedAt: new Date() },
        attempt: { number: cp.attempts + 1, identity: cp.runId ?? cp.stepId },
      });
      await tx
        .update(links)
        .set({ refreshCheckpoint: { ...cp, attempts: cp.attempts + 1 }, lastAttemptAt: new Date() })
        .where(scoped(tenantId, linkId));
      return url ?? true;
    });
  }
  private async photoUrl(tx: DbTx, link: Link, cp: RefreshCheckpoint): Promise<string | null> {
    if (!cp.photo || link.latestSnapshotId !== cp.photo.snapshotId) return null;
    const [snapshot] = await tx
      .select()
      .from(schema.nationalCatalogCardSnapshots)
      .where(
        and(
          eq(schema.nationalCatalogCardSnapshots.tenantId, link.tenantId),
          eq(schema.nationalCatalogCardSnapshots.productId, link.productId),
          eq(schema.nationalCatalogCardSnapshots.id, cp.photo.snapshotId),
        ),
      );
    if (!snapshot || snapshot.contentHash !== cp.photo.sourceHash) return null;
    const parsed = sourceEnvelopeSchema.safeParse(snapshot.payload);
    if (
      !parsed.success ||
      parsed.data.cardId !== link.cardId ||
      parsed.data.environment !== link.environment ||
      parsed.data.boundGtin14 !== link.boundGtin14
    )
      return null;
    const images = z.array(storedImageSchema).safeParse(parsed.data.normalized.images);
    if (!images.success) return null;
    const selected = images.data.filter(
      (image) => canonicalJsonHash(photoSelector(image)) === canonicalJsonHash(cp.photo?.selector),
    );
    return selected.length === 1 ? (selected[0]?.url ?? null) : null;
  }
  private async saveCard(
    tenantId: string,
    linkId: string,
    expected: RefreshCheckpoint,
    source: NationalCatalogProduct,
  ) {
    await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, linkId);
      if (!locked) return;
      const { link, product } = locked;
      const cp = this.current(link, expected);
      if (!cp || !(await this.allowed(tx, link, cp, product))) return;
      const payload = {
        sourceMethod: "feed_product",
        environment: link.environment,
        cardId: link.cardId,
        boundGtin14: link.boundGtin14,
        access: null,
        raw: source.raw,
        normalized: source,
      };
      const sourceHash = canonicalJsonHash(payload);
      const [existing] = await tx
        .select({ id: schema.nationalCatalogCardSnapshots.id })
        .from(schema.nationalCatalogCardSnapshots)
        .where(
          and(
            eq(schema.nationalCatalogCardSnapshots.tenantId, tenantId),
            eq(schema.nationalCatalogCardSnapshots.productId, link.productId),
            eq(schema.nationalCatalogCardSnapshots.cardId, link.cardId),
            eq(schema.nationalCatalogCardSnapshots.sourceMethod, "feed_product"),
            eq(schema.nationalCatalogCardSnapshots.contentHash, sourceHash),
          ),
        );
      const snapshotId = existing?.id ?? randomUUID();
      const now = new Date();
      if (!existing)
        await tx.insert(schema.nationalCatalogCardSnapshots).values({
          id: snapshotId,
          tenantId,
          productId: link.productId,
          gtin14: link.boundGtin14,
          cardId: link.cardId,
          cardStatus: source.status ?? "unknown",
          sourceMethod: "feed_product",
          payloadFormatVersion: 2,
          contentHash: sourceHash,
          payload,
          fetchedAt: now,
        });
      const reviewed = readCatalogProjection(link.reviewedProjection);
      const previous = readCatalogProjection(link.observedProjection);
      const knownPhoto = typeof previous?.values.photo === "string" ? previous.values.photo : null;
      const projection = reviewed
        ? observeCatalogProjection(source, link.boundGtin14, reviewed, knownPhoto)
        : null;
      const photoReview = photoReviewSchema.safeParse(link.reviewedPhoto);
      const selected =
        this.policy.photos.enabled && this.policy.photos.verifiedHosts.length && photoReview.success
          ? selectObservedPhoto(photoReview.data.selector, source.images)
          : null;
      const next: RefreshCheckpoint = selected
        ? {
            ...cp,
            phase: "photo",
            stepId: randomUUID(),
            runId: null,
            attempts: 0,
            nextRetryAt: null,
            enqueuePending: true,
            photo: { snapshotId, sourceHash, selector: photoSelector(selected) },
          }
        : { ...cp, phase: "done", runId: null, enqueuePending: false, nextRetryAt: null };
      await tx
        .update(links)
        .set({
          latestSnapshotId: snapshotId,
          lastSuccessAt: now,
          lastOutcome: "ok",
          rawStatus: source.status,
          rawDetailedStatuses: source.detailedStatuses,
          statusKeys: statuses(source.status, source.detailedStatuses),
          observedProjection: projection,
          observedMeaningfulHash: projection ? catalogProjectionHash(projection) : null,
          refreshCheckpoint: next,
          refreshErrorCode: null,
          updatedAt: now,
        })
        .where(scoped(tenantId, linkId));
      await this.audit(tx, link, cp, "success", null);
    });
  }
  private async savePhoto(
    tenantId: string,
    linkId: string,
    expected: RefreshCheckpoint,
    checksum: string,
  ) {
    await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, linkId);
      if (!locked) return;
      const { link, product } = locked;
      const cp = this.current(link, expected);
      if (
        !cp ||
        !(await this.allowed(tx, link, cp, product)) ||
        !(await this.photoUrl(tx, link, cp))
      )
        return;
      const projection = readCatalogProjection(link.observedProjection);
      const next = projection
        ? { ...projection, values: { ...projection.values, photo: checksum } }
        : null;
      await tx
        .update(links)
        .set({
          observedProjection: next,
          observedMeaningfulHash: next ? catalogProjectionHash(next) : null,
          refreshCheckpoint: {
            ...cp,
            phase: "done",
            runId: null,
            enqueuePending: false,
            nextRetryAt: null,
          },
          lastOutcome: "ok",
          refreshErrorCode: null,
          updatedAt: new Date(),
        })
        .where(scoped(tenantId, linkId));
      await this.audit(tx, link, cp, "success", null);
    });
  }
  private async failed(
    tenantId: string,
    linkId: string,
    expected: RefreshCheckpoint,
    error: unknown,
  ) {
    await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, tenantId, linkId);
      if (!locked) return;
      const { link, product } = locked;
      const cp = this.current(link, expected);
      if (!cp || !(await this.allowed(tx, link, cp, product))) return;
      const failure =
        error instanceof CatalogRequestError
          ? error
          : new CatalogRequestError("retry", "request_failed");
      const retry = failure.state === "deferred" || (failure.state === "retry" && cp.attempts < 4);
      const reason =
        cp.phase === "photo" && failure.state !== "deferred"
          ? "photo_unavailable"
          : cp.attempts >= 4 && failure.state === "retry"
            ? "retry_exhausted"
            : (safeRefreshErrorCode(failure.reason) ?? "request_failed");
      if (!retry) {
        await this.fail(tx, link, cp, reason);
        return;
      }
      await tx
        .update(links)
        .set({
          refreshCheckpoint: {
            ...cp,
            runId: null,
            nextRetryAt: (
              failure.nextRetryAt ?? nextRetryAt(Math.max(1, cp.attempts), new Date(), null)
            ).toISOString(),
          },
          lastOutcome: "error",
          refreshErrorCode: reason,
          updatedAt: new Date(),
        })
        .where(scoped(tenantId, linkId));
    });
  }
  private async fail(tx: DbTx, link: Link, cp: RefreshCheckpoint, reason: string) {
    const safe = safeRefreshErrorCode(reason) ?? "request_failed";
    await tx
      .update(links)
      .set({
        refreshCheckpoint: {
          ...cp,
          phase: "done",
          runId: null,
          enqueuePending: false,
          nextRetryAt: null,
        },
        lastOutcome: "error",
        refreshErrorCode: safe,
        updatedAt: new Date(),
      })
      .where(scoped(link.tenantId, link.id));
    await this.audit(tx, link, cp, "failure", safe);
  }
  private async audit(
    tx: DbTx,
    link: Link,
    cp: RefreshCheckpoint,
    outcome: "success" | "failure",
    reason: string | null,
  ) {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: link.tenantId,
      actorUserId: cp.actor.kind === "manual" ? cp.actor.userId : null,
      action: "national_catalog.link.refresh",
      outcome,
      targetType: "product",
      targetId: link.productId,
      after: {
        linkId: link.id,
        revision: cp.revision,
        stepId: cp.stepId,
        phase: cp.phase,
        actorKind: cp.actor.kind,
        attempts: cp.attempts,
        reason,
      },
    });
  }
  /** Bounded repair inventory. Task11 dispatches these opaque identities after commit. */
  async pending(limit = 100): Promise<Array<{ tenantId: string; linkId: string; stepId: string }>> {
    const result = await this.db.execute(
      sql`select tenant_id as "tenantId",id as "linkId",refresh_checkpoint->>'stepId' as "stepId" from national_catalog_product_links where closed_at is null and refresh_checkpoint->>'enqueuePending'='true' and (refresh_checkpoint->>'nextRetryAt' is null or (refresh_checkpoint->>'nextRetryAt')::timestamptz<=now()) order by last_attempt_at asc nulls first,tenant_id,id limit ${Math.max(1, Math.min(1000, limit))}`,
    );
    return result.rows.flatMap((row) =>
      typeof row.tenantId === "string" &&
      typeof row.linkId === "string" &&
      typeof row.stepId === "string"
        ? [{ tenantId: row.tenantId, linkId: row.linkId, stepId: row.stepId }]
        : [],
    );
  }
}
