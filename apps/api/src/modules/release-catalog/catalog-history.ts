import { historyPublicationDigest, assertHistoricalSigner } from "./catalog-history-product";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  publicationRequestSchema,
  deriveHistoryPlan,
  releaseHistoryEvidenceSchema,
  releaseOperationIdSchema,
  releaseSha256Schema,
  type ReleaseHistoryEvidence,
} from "@markiro/platform-contracts";
import type {
  PlatformAuditEvent,
  PlatformAuditService,
} from "../../platform-auth/platform-audit.service";
import type { CatalogLedger } from "./catalog-ledger";
import type { VerifiedCache, VerifiedFile } from "./catalog-cache";
import { CatalogFault, type VerifiedInputFile, type VerifiedReceipt } from "./catalog-types";
import { derivePublicPath } from "./catalog-policy";
import { assertProductPublication, assertStationPromotion } from "./catalog-product";
import { CatalogRepository } from "./catalog-repository";
import { catalogPublicationMetadata } from "./catalog-service";
import { historyCanonical } from "@markiro/platform-contracts";
const {
  releaseCatalogEpochs: epochs,
  releaseCatalogReceipts: receipts,
  releaseCatalogReservations: reservations,
  releaseCatalogIntents: intents,
  releaseCatalogPublications: publications,
  releaseCatalogObjects: objects,
} = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Actor = Pick<PlatformAuditEvent, "actorPlatformUserId" | "actorRole" | "requestId">;
export interface HistoryAdmission {
  epoch: string;
  evidenceSha256: string;
  actor: Actor;
}
interface Options {
  db: Db;
  ledger: CatalogLedger;
  cache: Pick<VerifiedCache, "acquire">;
  bucket: string;
  audit: Pick<PlatformAuditService, "record">;
  /** Protected operator adapter checks reviewed exact digest/scope/epoch/expiry, never an HTTP flag. */
  authorize(evidence: ReleaseHistoryEvidence, admission: HistoryAdmission): Promise<void>;
  /** Reobserve stopped API/publishers and retained journal before every mutation. */
  assertFenced(): Promise<void>;
}
export function historyEvidenceDigest(input: unknown) {
  return createHash("sha256")
    .update(historyCanonical(releaseHistoryEvidenceSchema.parse(input)))
    .digest("hex");
}
function id(value: unknown) {
  const h = createHash("sha256").update(historyCanonical(value)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Operator-only, never registered in an HTTP module. It cannot enable a writer or move a pointer. */
export class CatalogHistoryOperator {
  constructor(private readonly options: Options) {}
  private async guard(tx: Tx, evidence: ReleaseHistoryEvidence, admission: HistoryAdmission) {
    await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
    await tx.execute(sql`LOCK TABLE release_catalog_epochs IN SHARE ROW EXCLUSIVE MODE`);
    if ((await tx.select().from(epochs).where(eq(epochs.enabled, true))).length)
      throw new CatalogFault("not_ready");
    const [epoch] = await tx.select().from(epochs).where(eq(epochs.id, admission.epoch));
    if (
      !epoch ||
      epoch.product !== evidence.scope.product ||
      epoch.channel !== evidence.scope.channel
    )
      throw new CatalogFault("not_ready");
  }
  private async fresh(e: ReleaseHistoryEvidence, a: HistoryAdmission) {
    await this.options.authorize(e, a);
    await this.options.assertFenced();
  }
  private async addReceipt(tx: Tx, p: VerifiedReceipt, kind: "publication" | "reservation") {
    const [old] = await tx.select().from(receipts).where(eq(receipts.id, p.operationId));
    if (old) {
      if (
        old.sha256 !== p.sha256 ||
        old.ledgerKey !== p.ledgerKey ||
        old.ledgerVersionId !== p.ledgerVersionId ||
        old.kind !== kind
      )
        throw new CatalogFault("conflict");
      return;
    }
    await tx.insert(receipts).values({
      id: p.operationId,
      kind,
      sha256: p.sha256,
      ledgerKey: p.ledgerKey,
      ledgerVersionId: p.ledgerVersionId,
    });
  }
  async apply(input: unknown, admission: HistoryAdmission) {
    const evidence = releaseHistoryEvidenceSchema.parse(input),
      plan = deriveHistoryPlan(evidence),
      digest = historyEvidenceDigest(evidence);
    releaseOperationIdSchema.parse(admission.epoch);
    releaseSha256Schema.parse(admission.evidenceSha256);
    if (digest !== admission.evidenceSha256) throw new CatalogFault("forbidden");
    await this.fresh(evidence, admission);
    await this.options.db.transaction((tx) => this.guard(tx, evidence, admission));
    // Reservations are durable before importing any bytes. Failure leaves names occupied.
    for (let offset = 0; offset < plan.reservations.length; offset += 1000) {
      const entries = plan.reservations.slice(offset, offset + 1000),
        receiptId = id(["history-reservations", admission.epoch, digest, offset]);
      await this.fresh(evidence, admission);
      const proof = await this.options.ledger.prepare({
        schema: 1,
        id: receiptId,
        kind: "reservation",
        epoch: admission.epoch,
        identity: plan.scope,
        evidenceSha256: digest,
        entries,
      });
      await this.fresh(evidence, admission);
      await this.options.db.transaction(async (tx) => {
        await this.guard(tx, evidence, admission);
        await this.addReceipt(tx, proof, "reservation");
        const [applied] = await tx
          .select()
          .from(reservations)
          .where(eq(reservations.receiptId, receiptId));
        if (applied) return;
        for (const entry of entries)
          await tx
            .insert(reservations)
            .values({ id: id([receiptId, entry]), ...plan.scope, ...entry, receiptId });
        await this.options.audit.record(tx, {
          ...admission.actor,
          action: "release_catalog.history.reserve",
          outcome: "success",
          tenantId: null,
          targetType: "release_catalog",
          targetId: receiptId,
          reason: null,
          before: null,
          after: {
            evidenceSha256: digest,
            scope: plan.scope,
            count: entries.length,
            writersEnabled: false,
          },
        });
      });
    }
    const imported: string[] = [];
    const repo = new CatalogRepository(this.options.db, this.options.audit);
    for (const entry of plan.imports) {
      const request = entry.publication;
      if (!request) throw new CatalogFault("invalid_request");
      const intentId = id(["history-publication", admission.epoch, digest, request.identity]),
        requestDigest = historyPublicationDigest(request);
      const pinned = entry.objects.map((o) => ({
        publicPath: derivePublicPath(request.identity, o.name),
        bucket: this.options.bucket,
        key: o.key,
        versionId: o.versionId,
        sha256: o.sha256,
        sizeBytes: o.sizeBytes,
        contentType: o.contentType,
      }));
      await this.fresh(evidence, admission);
      await this.options.db.transaction(async (tx) => {
        await this.guard(tx, evidence, admission);
        const [prior] = await tx
          .select()
          .from(intents)
          .where(
            and(
              eq(intents.product, request.identity.product),
              eq(intents.channel, request.identity.channel),
              eq(intents.version, request.identity.version),
            ),
          );
        if (prior) {
          if (
            prior.id !== intentId ||
            prior.requestDigest !== requestDigest ||
            prior.epochId !== admission.epoch
          )
            throw new CatalogFault("conflict");
          return;
        }
        await tx.insert(intents).values({
          id: intentId,
          epochId: admission.epoch,
          ownerFingerprint: digest,
          idempotencyKey: intentId,
          requestDigest,
          ...request.identity,
          request,
          expiresAt: new Date(Date.now() + 900000),
          state: "pending",
        });
      });
      const leases: VerifiedFile[] = [],
        files = new Map<string, VerifiedInputFile>();
      let metadata;
      try {
        for (const spec of request.files) {
          const object = pinned.find(
            (o) => o.publicPath === derivePublicPath(request.identity, spec.name),
          );
          if (!object) throw new CatalogFault("conflict");
          const lease = await this.options.cache.acquire(object);
          leases.push(lease);
          files.set(spec.name, {
            spec,
            sha256: lease.sha256,
            sizeBytes: lease.size,
            read: (max) => lease.read(max),
          });
        }
        metadata =
          request.evidence.kind === "signer"
            ? await assertHistoricalSigner(request, files)
            : await assertProductPublication(publicationRequestSchema.parse(request), files);
        if (request.identity.product === "station" && request.identity.channel === "stable") {
          if (metadata.product !== "station") throw new CatalogFault("conflict");
          const version = metadata.evidence?.betaVersion;
          if (typeof version !== "string") throw new CatalogFault("conflict");
          const beta = await repo.publicationByIdentity({
            product: "station",
            channel: "beta",
            version,
          });
          if (!beta) throw new CatalogFault("not_ready");
          assertStationPromotion(
            metadata,
            catalogPublicationMetadata(beta.publication),
            new Map(request.files.map((f) => [f.name, f.sha256])),
            new Map(beta.files.map((f) => [f.name, f.sha256])),
          );
        }
      } finally {
        for (const lease of leases) await lease.close();
      }
      await this.fresh(evidence, admission);
      const proof = await this.options.ledger.prepare({
        schema: 1,
        id: intentId,
        kind: "publication",
        epoch: admission.epoch,
        identity: request.identity,
        requestDigest,
        sourceSha: request.sourceSha,
        files: pinned,
      });
      await this.fresh(evidence, admission);
      const publicationId = id(["history-binding", intentId]);
      await this.options.db.transaction(async (tx) => {
        await this.guard(tx, evidence, admission);
        const [existing] = await tx
          .select()
          .from(publications)
          .where(eq(publications.intentId, intentId));
        if (existing) {
          if (
            existing.id !== publicationId ||
            existing.requestDigest !== requestDigest ||
            existing.receiptId !== proof.operationId
          )
            throw new CatalogFault("conflict");
          return;
        }
        await this.addReceipt(tx, proof, "publication");
        await tx.insert(publications).values({
          id: publicationId,
          intentId,
          ...request.identity,
          requestDigest,
          sourceSha: request.sourceSha,
          fileCount: request.files.length,
          metadata,
          receiptId: proof.operationId,
        });
        for (const o of pinned) {
          const name = o.publicPath.slice(o.publicPath.lastIndexOf("/") + 1);
          await tx.insert(objects).values({ ...o, ...request.identity, name, publicationId });
        }
        await tx.update(intents).set({ state: "committed" }).where(eq(intents.id, intentId));
        await this.options.audit.record(tx, {
          ...admission.actor,
          action: "release_catalog.history.import",
          outcome: "success",
          tenantId: null,
          targetType: "release_catalog_publication",
          targetId: publicationId,
          reason: null,
          before: null,
          after: {
            scope: plan.scope,
            version: request.identity.version,
            requestDigest,
            evidenceSha256: digest,
            writersEnabled: false,
          },
        });
      });
      await this.fresh(evidence, admission);
      await this.options.ledger.prepare({
        schema: 1,
        id: id(["history-confirmation", intentId]),
        kind: "confirmation",
        preparedId: intentId,
        preparedSha256: proof.sha256,
        result: { kind: "publication", publicationId },
      });
      imported.push(publicationId);
    }
    return { evidenceSha256: digest, publications: imported, writersMayEnable: false as const };
  }
}
