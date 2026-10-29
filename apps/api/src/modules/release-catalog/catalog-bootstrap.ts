import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "@markiro/db";
import {
  deriveHistoryPlan,
  historyCanonical,
  releaseHistoryEvidenceSchema,
  releaseOperationIdSchema,
} from "@markiro/platform-contracts";
import type { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { CatalogLedger } from "./catalog-ledger";
import type { VerifiedCache } from "./catalog-cache";
import { CatalogHistoryOperator, historyEvidenceDigest } from "./catalog-history";
import { CatalogRepository } from "./catalog-repository";
import { assertProductPublication } from "./catalog-product";
import { catalogPublicationMetadata } from "./catalog-service";
import { catalogPointerBytes, digest } from "./catalog-receipts";
import { CatalogFault, type VerifiedInputFile, type VerifiedReceipt } from "./catalog-types";

const inputSchema = z
  .object({
    schema: z.literal(1),
    operationId: releaseOperationIdSchema,
    targetVersion: z.string().min(1).max(128),
    evidence: releaseHistoryEvidenceSchema,
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
export interface BootstrapBinding {
  operationId: string;
  epoch: string;
  evidenceSha256: string;
  identity: Input["evidence"]["scope"];
  targetVersion: string;
}
interface Options {
  db: Db;
  ledger: CatalogLedger;
  cache: Pick<VerifiedCache, "acquire">;
  bucket: string;
  audit: Pick<PlatformAuditService, "record">;
  /** Exact protected dispatch, reviewed digest and independent approval. No HTTP caller. */
  authorize(binding: BootstrapBinding): Promise<void>;
  /** Actual stopped API, publishers and old executors; called again before each mutation. */
  assertFenced(): Promise<void>;
}
const {
  releaseCatalogEpochs: epochs,
  releaseCatalogChannels: channels,
  releaseCatalogChannelEvents: events,
  releaseCatalogReceipts: receipts,
  releaseCatalogPublications: publications,
  releaseCatalogIntents: intents,
} = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
function deterministicId(value: unknown) {
  const h = createHash("sha256").update(historyCanonical(value)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function bootstrapEvidenceDigest(input: unknown) {
  return digest(Buffer.from(historyCanonical(inputSchema.parse(input))));
}
/** Initial read visibility only. Never enables a writer, changes a nonempty channel or mounts an HTTP route. */
export class CatalogReadBootstrapOperator {
  constructor(private readonly options: Options) {}
  private async fresh(binding: BootstrapBinding) {
    await this.options.authorize(binding);
    await this.options.assertFenced();
  }
  private async guard(tx: Tx, b: BootstrapBinding, create: boolean) {
    await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
    await tx.execute(sql`LOCK TABLE release_catalog_epochs IN SHARE ROW EXCLUSIVE MODE`);
    if ((await tx.select().from(epochs).where(eq(epochs.enabled, true))).length)
      throw new CatalogFault("not_ready");
    const rows = await tx
      .select()
      .from(epochs)
      .where(and(eq(epochs.product, b.identity.product), eq(epochs.channel, b.identity.channel)));
    if (rows.length && (rows.length !== 1 || rows[0]?.id !== b.epoch))
      throw new CatalogFault("conflict");
    if (!rows.length) {
      if (!create) throw new CatalogFault("not_ready");
      // The deterministic epoch binds this exact evidence and operation even after an interrupted import.
      await tx.insert(epochs).values({ id: b.epoch, ...b.identity, enabled: false });
      await this.options.audit.record(tx, {
        actorPlatformUserId: null,
        actorRole: null,
        requestId: b.operationId,
        action: "release_catalog.bootstrap.prepare",
        outcome: "success",
        tenantId: null,
        targetType: "release_catalog_epoch",
        targetId: b.epoch,
        reason: "initial-read-only",
        before: null,
        after: { ...b, writersEnabled: false },
      });
    }
  }
  async apply(input: unknown) {
    const parsed = inputSchema.parse(input),
      plan = deriveHistoryPlan(parsed.evidence);
    const target = plan.imports.find((entry) => entry.version === parsed.targetVersion);
    if (
      !target?.publication ||
      plan.scope.product === "signer" ||
      plan.reservations.some((r) => r.kind === "closed")
    )
      throw new CatalogFault("not_ready");
    const binding: BootstrapBinding = {
      operationId: parsed.operationId,
      epoch: deterministicId([
        "read-bootstrap",
        parsed.operationId,
        bootstrapEvidenceDigest(parsed),
      ]),
      evidenceSha256: bootstrapEvidenceDigest(parsed),
      identity: plan.scope,
      targetVersion: parsed.targetVersion,
    };
    const actor = { actorPlatformUserId: null, actorRole: null, requestId: parsed.operationId };
    await this.fresh(binding);
    await this.options.db.transaction((tx) => this.guard(tx, binding, true));
    const imported = await new CatalogHistoryOperator({
      ...this.options,
      authorize: async () => this.fresh(binding),
    }).apply(parsed.evidence, {
      epoch: binding.epoch,
      evidenceSha256: historyEvidenceDigest(parsed.evidence),
      actor,
    });
    const repo = new CatalogRepository(this.options.db, this.options.audit);
    const found = await repo.publicationByIdentity(target.publication.identity);
    if (!found || !imported.publications.includes(found.publication.id))
      throw new CatalogFault("not_ready");
    const publication = await repo.publication(found.publication.id);
    const files = new Map<string, VerifiedInputFile>();
    const leases = [];
    try {
      for (const spec of publication.request.files) {
        const object = publication.files.find((f) => f.name === spec.name);
        if (!object) throw new CatalogFault("not_ready");
        const lease = await this.options.cache.acquire(object);
        leases.push(lease);
        files.set(spec.name, {
          spec,
          sha256: lease.sha256,
          sizeBytes: lease.size,
          read: (max) => lease.read(max),
        });
      }
      const metadata = await assertProductPublication(publication.request, files);
      if (
        historyCanonical(metadata) !==
        historyCanonical(catalogPublicationMetadata(found.publication))
      )
        throw new CatalogFault("conflict");
    } finally {
      for (const lease of leases) await lease.close();
    }
    const pointer = catalogPublicationMetadata(found.publication).pointer;
    const bytes = catalogPointerBytes(pointer);
    await this.fresh(binding);
    const proof = await this.options.ledger.prepare({
      schema: 1,
      id: parsed.operationId,
      kind: "channel",
      epoch: binding.epoch,
      identity: binding.identity,
      expectedRevision: "0",
      revision: "1",
      previousPublicationId: null,
      publicationId: found.publication.id,
      transition: "forward",
      pointer: {
        base64: bytes.toString("base64"),
        sha256: digest(bytes),
        sizeBytes: bytes.length,
        contentType: "application/json",
      },
    });
    await this.fresh(binding);
    await this.options.db.transaction(async (tx) => {
      await this.guard(tx, binding, false);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`release-catalog:${binding.identity.product}/${binding.identity.channel}`}, 0))`,
      );
      const [existing] = await tx.select().from(events).where(eq(events.id, parsed.operationId));
      const [current] = await tx
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.product, binding.identity.product),
            eq(channels.channel, binding.identity.channel),
          ),
        )
        .for("update");
      if (existing) {
        if (
          !current ||
          current.revision !== 1n ||
          !current.readable ||
          current.publicationId !== found.publication.id ||
          existing.product !== binding.identity.product ||
          existing.channel !== binding.identity.channel ||
          existing.expectedRevision !== 0n ||
          existing.revision !== 1n ||
          existing.previousPublicationId !== null ||
          existing.publicationId !== found.publication.id ||
          existing.kind !== "forward" ||
          existing.receiptId !== proof.operationId ||
          historyCanonical(existing.pointer) !== historyCanonical(pointer)
        )
          throw new CatalogFault("conflict");
        await this.receipt(tx, proof);
        return;
      }
      if (
        current &&
        (current.revision !== 0n || current.publicationId !== null || current.readable)
      )
        throw new CatalogFault("conflict");
      const [committed] = await tx
        .select({ epoch: intents.epochId, state: intents.state })
        .from(publications)
        .innerJoin(intents, eq(intents.id, publications.intentId))
        .where(eq(publications.id, found.publication.id));
      if (!committed || committed.epoch !== binding.epoch || committed.state !== "committed")
        throw new CatalogFault("not_ready");
      await this.receipt(tx, proof);
      await tx.insert(events).values({
        id: parsed.operationId,
        ...binding.identity,
        expectedRevision: 0n,
        revision: 1n,
        previousPublicationId: null,
        publicationId: found.publication.id,
        kind: "forward",
        receiptId: proof.operationId,
        pointer,
      });
      const next = { revision: 1n, publicationId: found.publication.id, readable: true };
      await tx
        .insert(channels)
        .values({ ...binding.identity, ...next })
        .onConflictDoUpdate({ target: [channels.product, channels.channel], set: next });
      await this.options.audit.record(tx, {
        ...actor,
        action: "release_catalog.channel.bootstrap",
        outcome: "success",
        tenantId: null,
        targetType: "release_catalog_channel",
        targetId: `${binding.identity.product}/${binding.identity.channel}`,
        reason: "initial-read-only",
        before: { revision: "0", publicationId: null },
        after: {
          revision: "1",
          publicationId: found.publication.id,
          evidenceSha256: binding.evidenceSha256,
          epoch: binding.epoch,
          writersEnabled: false,
        },
      });
    });
    await this.fresh(binding);
    // Deterministic confirmation permits exact retries after a lost COMMIT response; never moves a pointer from a prepare alone.
    await this.options.ledger.prepare({
      schema: 1,
      id: deterministicId(["bootstrap-confirmation", parsed.operationId]),
      kind: "confirmation",
      preparedId: parsed.operationId,
      preparedSha256: proof.sha256,
      result: { kind: "channel", publicationId: found.publication.id, revision: "1" },
    });
    return {
      identity: binding.identity,
      epoch: binding.epoch,
      revision: "1",
      publicationId: found.publication.id,
      readable: true,
      writersMayEnable: false as const,
    };
  }
  private async receipt(tx: Tx, proof: VerifiedReceipt) {
    const [old] = await tx.select().from(receipts).where(eq(receipts.id, proof.operationId));
    if (old) {
      if (
        old.kind !== "channel" ||
        old.sha256 !== proof.sha256 ||
        old.ledgerKey !== proof.ledgerKey ||
        old.ledgerVersionId !== proof.ledgerVersionId
      )
        throw new CatalogFault("conflict");
    } else
      await tx.insert(receipts).values({
        id: proof.operationId,
        kind: "channel",
        sha256: proof.sha256,
        ledgerKey: proof.ledgerKey,
        ledgerVersionId: proof.ledgerVersionId,
      });
  }
}
