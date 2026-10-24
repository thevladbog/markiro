import { catalogPointerBytes } from "./catalog-receipts";
import { publicCatalogRoute, type CatalogReadSnapshot } from "./catalog-read";
import { createHash, randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import {
  channelChangeRequestSchema,
  isReservedHistoryVersion,
  channelSnapshotSchema,
  publicationRequestSchema,
  releaseOperationIdSchema,
  releaseSha256Schema,
  releaseVersionIdSchema,
  type ChannelSnapshot,
  type PublicationRequest,
} from "@markiro/platform-contracts";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type {
  PlatformAuditEvent,
  PlatformAuditService,
} from "../../platform-auth/platform-audit.service";
import { canonicalPublicationDigest, derivePublicPath, deriveUploadKey } from "./catalog-policy";
import { CatalogFault, type PinnedObject, type VerifiedReceipt } from "./catalog-types";

const {
  releaseCatalogEpochs: epochs,
  releaseCatalogIntents: intents,
  releaseCatalogPublications: publications,
  releaseCatalogObjects: objects,
  releaseCatalogReceipts: receipts,
  releaseCatalogReservations: reservations,
  releaseCatalogChannels: channels,
  releaseCatalogChannelEvents: events,
  releaseCatalogOidcBindings: oidcBindings,
} = schema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Scope = ChannelSnapshot["identity"];
type IntentRow = typeof intents.$inferSelect;
export type PublicationRow = typeof publications.$inferSelect;
export interface CatalogPrincipal {
  fingerprint: string;
  tokenHash?: string;
}
type Actor = Pick<PlatformAuditEvent, "actorPlatformUserId" | "actorRole" | "requestId">;
export interface CatalogPublicationInput {
  metadata: Record<string, unknown>;
  objects: PinnedObject[];
}
const channelChangeSchema = channelChangeRequestSchema.extend({
  identity: channelSnapshotSchema.shape.identity,
  epoch: releaseOperationIdSchema,
  pointer: z.record(z.string(), z.unknown()),
});
const receiptSchema = z
  .object({
    operationId: releaseOperationIdSchema,
    sha256: releaseSha256Schema,
    ledgerKey: z.string(),
    ledgerVersionId: releaseVersionIdSchema,
  })
  .strict()
  .refine((r) => r.ledgerKey === `_publication-ledger/${r.operationId}.json`);
function parse<T>(validator: z.ZodType<T>, input: unknown): T {
  const result = validator.safeParse(input);
  if (!result.success) throw new CatalogFault("invalid_request");
  return result.data;
}
function scopeWhere(
  t: {
    product:
      | typeof epochs.product
      | typeof intents.product
      | typeof publications.product
      | typeof reservations.product
      | typeof channels.product;
    channel:
      | typeof epochs.channel
      | typeof intents.channel
      | typeof publications.channel
      | typeof reservations.channel
      | typeof channels.channel;
  },
  scope: Scope,
) {
  return and(eq(t.product, scope.product), eq(t.channel, scope.channel));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new CatalogFault("invalid_request");
  return result;
}
function databaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return "cause" in error ? databaseCode(error.cause) : undefined;
}
function owner(principal: CatalogPrincipal, intent: IntentRow) {
  parse(releaseSha256Schema, principal.fingerprint);
  if (intent.ownerFingerprint !== principal.fingerprint) throw new CatalogFault("forbidden");
}
function view(intent: IntentRow) {
  return { ...intent, request: parse(publicationRequestSchema, intent.request) };
}

/** DB-only boundary. Verified byte/ledger proof and fresh authorization are supplied by the service. */
export class CatalogRepository {
  constructor(
    private readonly db: Db,
    private readonly audit: Pick<PlatformAuditService, "record">,
    private readonly now: () => number = Date.now,
  ) {}
  private async transaction<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
        return body(tx);
      });
    } catch (error) {
      const code = databaseCode(error);
      if (code === "23505") throw new CatalogFault("conflict");
      if (code === "55P03" || code === "40P01" || code === "40001" || code === "57014")
        throw new CatalogFault("unavailable");
      throw error;
    }
  }
  private async lock(tx: Tx, key: string) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`release-catalog:${key}`}, 0))`,
    );
  }
  private async epoch(tx: Tx, scope: Scope, expected?: string) {
    const [row] = await tx
      .select()
      .from(epochs)
      .where(and(scopeWhere(epochs, scope), eq(epochs.enabled, true)))
      .for("share");
    if (!row || (expected !== undefined && row.id !== expected))
      throw new CatalogFault("not_ready");
    return row;
  }
  private async bindToken(tx: Tx, principal: CatalogPrincipal, intentId: string) {
    if (principal.tokenHash === undefined) return;
    const tokenHash = parse(releaseSha256Schema, principal.tokenHash);
    await this.lock(tx, `oidc:${tokenHash}`);
    const [previous] = await tx
      .select()
      .from(oidcBindings)
      .where(eq(oidcBindings.tokenHash, tokenHash));
    if (previous) {
      if (previous.intentId !== intentId || previous.principalHash !== principal.fingerprint)
        throw new CatalogFault("forbidden");
      return;
    }
    await tx
      .insert(oidcBindings)
      .values({ tokenHash, intentId, principalHash: principal.fingerprint });
  }
  private async unreserved(tx: Tx, request: PublicationRequest) {
    const rows = await tx
      .select()
      .from(reservations)
      .where(scopeWhere(reservations, request.identity));
    // Unknown history is closed. A reviewed issued upper bound reserves its entire semver base.
    if (rows.some((r) => r.kind === "closed")) throw new CatalogFault("not_ready");
    if (
      rows.some(
        (r) =>
          r.kind === "range" &&
          (r.upperBound === null ||
            isReservedHistoryVersion(request.identity.version, r.upperBound)),
      )
    )
      throw new CatalogFault("conflict");
    const paths = new Set(request.files.map((f) => derivePublicPath(request.identity, f.name)));
    if (
      rows.some(
        (r) =>
          r.version === request.identity.version ||
          (r.publicPath !== null && paths.has(r.publicPath)),
      )
    )
      throw new CatalogFault("conflict");
  }
  async reserveIntent(principal: CatalogPrincipal, idempotencyKey: unknown, input: unknown) {
    const fingerprint = parse(releaseSha256Schema, principal.fingerprint);
    const key = parse(releaseOperationIdSchema, idempotencyKey);
    const request = parse(publicationRequestSchema, input),
      digest = canonicalPublicationDigest(request);
    return this.transaction(async (tx) => {
      await this.lock(tx, `owner:${fingerprint}:${key}`);
      await this.lock(tx, `${request.identity.product}/${request.identity.channel}`);
      const epoch = await this.epoch(tx, request.identity);
      const [previous] = await tx
        .select()
        .from(intents)
        .where(and(eq(intents.ownerFingerprint, fingerprint), eq(intents.idempotencyKey, key)));
      if (previous) {
        if (previous.requestDigest !== digest) throw new CatalogFault("conflict");
        if (previous.epochId !== epoch.id) throw new CatalogFault("not_ready");
        await this.bindToken(tx, principal, previous.id);
        return view(previous);
      }
      await this.unreserved(tx, request);
      const [row] = await tx
        .insert(intents)
        .values({
          id: randomUUID(),
          epochId: epoch.id,
          ownerFingerprint: fingerprint,
          idempotencyKey: key,
          requestDigest: digest,
          ...request.identity,
          request,
          expiresAt: new Date(this.now() + 15 * 60 * 1000),
        })
        .returning();
      if (!row) throw new CatalogFault("unavailable");
      await this.bindToken(tx, principal, row.id);
      return view(row);
    });
  }
  async getIntent(principal: CatalogPrincipal, id: unknown) {
    return this.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(intents)
        .where(eq(intents.id, parse(releaseOperationIdSchema, id)));
      if (!row) throw new CatalogFault("not_found");
      owner(principal, row);
      await this.epoch(
        tx,
        parse(channelSnapshotSchema.shape.identity, { product: row.product, channel: row.channel }),
        row.epochId,
      );
      await this.bindToken(tx, principal, row.id);
      return view(row);
    });
  }
  private async addReceipt(tx: Tx, receipt: VerifiedReceipt, kind: "publication" | "channel") {
    const r = parse(receiptSchema, receipt);
    await tx.insert(receipts).values({
      id: r.operationId,
      kind,
      sha256: r.sha256,
      ledgerKey: r.ledgerKey,
      ledgerVersionId: r.ledgerVersionId,
    });
  }
  private validateObjects(intent: IntentRow, input: CatalogPublicationInput) {
    const request = parse(publicationRequestSchema, intent.request);
    if (
      !input.metadata ||
      Array.isArray(input.metadata) ||
      typeof input.metadata !== "object" ||
      Buffer.byteLength(stableJson(input.metadata)) > 65536
    )
      throw new CatalogFault("invalid_request");
    if (input.objects.length !== request.files.length) throw new CatalogFault("conflict");
    const paths = new Set<string>();
    for (const object of input.objects) {
      const file = request.files.find(
        (f) => derivePublicPath(request.identity, f.name) === object.publicPath,
      );
      if (
        !file ||
        paths.has(object.publicPath) ||
        object.key !== deriveUploadKey(request.identity.product, intent.id, file.name) ||
        object.sha256 !== file.sha256 ||
        object.sizeBytes !== file.sizeBytes ||
        object.contentType !== file.contentType
      )
        throw new CatalogFault("conflict");
      parse(releaseVersionIdSchema, object.versionId);
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(object.bucket))
        throw new CatalogFault("invalid_request");
      paths.add(object.publicPath);
    }
    return request;
  }
  async commitPublication(
    principal: CatalogPrincipal,
    id: unknown,
    epoch: unknown,
    input: CatalogPublicationInput,
    receipt: VerifiedReceipt,
    actor: Actor,
    beforeCommit?: (registered: PublicationRow[]) => void,
  ): Promise<{ outcome: "registered" | "unchanged"; publication: PublicationRow }> {
    const intentId = parse(releaseOperationIdSchema, id),
      expected = parse(releaseOperationIdSchema, epoch);
    return this.transaction(async (tx) => {
      const [initial] = await tx.select().from(intents).where(eq(intents.id, intentId));
      if (!initial) throw new CatalogFault("not_found");
      owner(principal, initial);
      const request = this.validateObjects(initial, input);
      await this.lock(tx, `${initial.product}/${initial.channel}`);
      await this.epoch(tx, request.identity, expected);
      if (initial.epochId !== expected) throw new CatalogFault("not_ready");
      const [intent] = await tx
        .select()
        .from(intents)
        .where(eq(intents.id, intentId))
        .for("update");
      if (!intent) throw new CatalogFault("not_found");
      await this.bindToken(tx, principal, intent.id);
      const [existing] = await tx
        .select()
        .from(publications)
        .where(eq(publications.intentId, intentId));
      if (existing) return { outcome: "unchanged", publication: existing };
      if (
        intent.state === "failed" ||
        intent.state === "committed" ||
        intent.expiresAt.getTime() <= this.now()
      )
        throw new CatalogFault("not_ready");
      await this.unreserved(tx, request);
      beforeCommit?.(
        await tx.select().from(publications).where(scopeWhere(publications, request.identity)),
      );
      await this.addReceipt(tx, receipt, "publication");
      const [publication] = await tx
        .insert(publications)
        .values({
          id: randomUUID(),
          intentId,
          ...request.identity,
          requestDigest: intent.requestDigest,
          sourceSha: request.sourceSha,
          fileCount: request.files.length,
          metadata: input.metadata,
          receiptId: receipt.operationId,
        })
        .returning();
      if (!publication) throw new CatalogFault("unavailable");
      for (const file of request.files) {
        const object = input.objects.find(
          (o) => o.publicPath === derivePublicPath(request.identity, file.name),
        );
        if (!object) throw new CatalogFault("conflict");
        await tx.insert(objects).values({
          ...object,
          ...request.identity,
          name: file.name,
          publicationId: publication.id,
        });
      }
      await this.audit.record(tx, {
        ...actor,
        action: "release_catalog.publication.register",
        outcome: "success",
        tenantId: null,
        targetType: "release_catalog_publication",
        targetId: publication.id,
        reason: null,
        before: null,
        after: {
          identity: request.identity,
          requestDigest: intent.requestDigest,
          sourceSha: request.sourceSha,
          fileCount: request.files.length,
          principalFingerprint: principal.fingerprint,
        },
      });
      await tx.update(intents).set({ state: "committed" }).where(eq(intents.id, intentId));
      return { outcome: "registered", publication };
    });
  }
  async activeEpoch(input: unknown) {
    const scope = parse(channelSnapshotSchema.shape.identity, input);
    return this.transaction(async (tx) => (await this.epoch(tx, scope)).id);
  }
  async publicationByIntent(id: string) {
    const [row] = await this.db
      .select()
      .from(publications)
      .where(eq(publications.intentId, parse(releaseOperationIdSchema, id)));
    return row ? this.publication(row.id) : null;
  }
  async publication(id: string) {
    const [row] = await this.db
      .select()
      .from(publications)
      .where(eq(publications.id, parse(releaseOperationIdSchema, id)));
    if (!row) throw new CatalogFault("not_found");
    const files = await this.db.select().from(objects).where(eq(objects.publicationId, row.id));
    const [intent] = await this.db.select().from(intents).where(eq(intents.id, row.intentId));
    if (!intent || files.length !== row.fileCount) throw new CatalogFault("not_ready");
    return {
      publication: row,
      files: files.map((f) => ({
        ...f,
        contentType: parse(
          publicationRequestSchema.shape.files.element.shape.contentType,
          f.contentType,
        ),
      })),
      request: parse(publicationRequestSchema, intent.request),
    };
  }
  async publicationByIdentity(identity: PublicationRequest["identity"]) {
    const [row] = await this.db
      .select()
      .from(publications)
      .where(and(scopeWhere(publications, identity), eq(publications.version, identity.version)));
    return row ? this.publication(row.id) : null;
  }
  async channelEvent(id: string) {
    const [row] = await this.db
      .select()
      .from(events)
      .where(eq(events.id, parse(releaseOperationIdSchema, id)));
    return row ?? null;
  }
  async readSnapshot(path: string): Promise<CatalogReadSnapshot | null> {
    const route = publicCatalogRoute(path);
    if (!route) return null;
    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout='15s'`);
        const pinned = (row: typeof objects.$inferSelect): PinnedObject => ({
          publicPath: row.publicPath,
          bucket: row.bucket,
          key: row.key,
          versionId: row.versionId,
          sha256: row.sha256,
          sizeBytes: row.sizeBytes,
          contentType: parse(
            publicationRequestSchema.shape.files.element.shape.contentType,
            row.contentType,
          ),
        });
        if (route.kind === "immutable") {
          const [row] = await tx
            .select({ object: objects })
            .from(objects)
            .innerJoin(publications, eq(objects.publicationId, publications.id))
            .where(eq(objects.publicPath, path));
          return row ? { kind: "object", object: pinned(row.object), mutable: false } : null;
        }
        const [channel] = await tx
          .select()
          .from(channels)
          .where(scopeWhere(channels, route.identity));
        if (!channel || channel.revision === 0n) return null;
        if (!channel.readable || !channel.publicationId) throw new CatalogFault("not_ready");
        const [event] = await tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.product, route.identity.product),
              eq(events.channel, route.identity.channel),
              eq(events.revision, channel.revision),
            ),
          );
        const [publication] = await tx
          .select()
          .from(publications)
          .where(eq(publications.id, channel.publicationId));
        if (
          !event ||
          !publication ||
          event.publicationId !== publication.id ||
          publication.product !== route.identity.product ||
          publication.channel !== route.identity.channel ||
          stableJson(event.pointer) !== stableJson(publication.metadata.pointer)
        )
          throw new CatalogFault("not_ready");
        const files = await tx
          .select()
          .from(objects)
          .where(eq(objects.publicationId, publication.id));
        if (files.length !== publication.fileCount) throw new CatalogFault("not_ready");
        if (route.kind === "pointer") {
          const bytes = catalogPointerBytes(event.pointer);
          if (bytes.length > 65536) throw new CatalogFault("not_ready");
          return {
            kind: "pointer",
            bytes,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          };
        }
        const name =
          publication.product === "handheld"
            ? `markiro-tsd-${publication.version}.apk`
            : `markiro-${publication.product}-${publication.version}-windows-x86_64-setup.exe`;
        const file = files.find((f) => f.name === name);
        if (!file) throw new CatalogFault("not_ready");
        return { kind: "object", object: pinned(file), mutable: true };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  async readPath(path: string): Promise<PinnedObject | null> {
    const [row] = await this.db
      .select({
        publicPath: objects.publicPath,
        bucket: objects.bucket,
        key: objects.key,
        versionId: objects.versionId,
        sha256: objects.sha256,
        sizeBytes: objects.sizeBytes,
        contentType: objects.contentType,
      })
      .from(objects)
      .innerJoin(publications, eq(objects.publicationId, publications.id))
      .where(eq(objects.publicPath, path));
    if (!row) return null;
    return {
      ...row,
      contentType: parse(
        publicationRequestSchema.shape.files.element.shape.contentType,
        row.contentType,
      ),
    };
  }
  async readChannel(input: unknown): Promise<ChannelSnapshot> {
    const identity = parse(channelSnapshotSchema.shape.identity, input);
    const [row] = await this.db.select().from(channels).where(scopeWhere(channels, identity));
    return {
      identity,
      revision: row?.revision.toString() ?? "0",
      publicationId: row?.publicationId ?? null,
      readable: row?.readable ?? false,
    };
  }
  private async bindChannelTarget(
    tx: Tx,
    principal: CatalogPrincipal,
    targetId: string,
    scope: Scope,
    epoch: string,
  ) {
    const [row] = await tx
      .select({ intent: intents, publication: publications })
      .from(publications)
      .innerJoin(intents, eq(publications.intentId, intents.id))
      .where(eq(publications.id, targetId));
    if (
      !row ||
      row.publication.product !== scope.product ||
      row.publication.channel !== scope.channel
    )
      throw new CatalogFault("conflict");
    if (row.intent.epochId !== epoch || row.intent.state !== "committed")
      throw new CatalogFault("not_ready");
    await this.bindToken(tx, principal, row.intent.id);
  }
  /** Channel authority is product-scoped; upload ownership remains enforced by get/commitIntent. */
  async authorizeChannelTarget(
    principal: CatalogPrincipal,
    targetId: string,
    scope: Scope,
    epoch: string,
  ) {
    return this.transaction(async (tx) => {
      await this.epoch(tx, scope, epoch);
      await this.bindChannelTarget(tx, principal, targetId, scope, epoch);
    });
  }
  async commitChannelChange(
    input: unknown,
    receipt: VerifiedReceipt,
    actor: Actor,
    authority?: {
      principal?: CatalogPrincipal;
      beforeCommit: (target: PublicationRow, previous: PublicationRow | null) => void;
    },
  ): Promise<ChannelSnapshot> {
    const change = parse(channelChangeSchema, input),
      { identity } = change;
    if (Buffer.byteLength(stableJson(change.pointer)) > 65536)
      throw new CatalogFault("invalid_request");
    return this.transaction(async (tx) => {
      await this.lock(tx, `${identity.product}/${identity.channel}`);
      await this.epoch(tx, identity, change.epoch);
      const [previous] = await tx.select().from(events).where(eq(events.id, change.operationId));
      if (authority?.principal) {
        await this.bindChannelTarget(
          tx,
          authority.principal,
          change.targetPublicationId,
          identity,
          change.epoch,
        );
      }
      if (previous) {
        if (
          previous.product !== identity.product ||
          previous.channel !== identity.channel ||
          previous.expectedRevision.toString() !== change.expectedRevision ||
          previous.publicationId !== change.targetPublicationId ||
          previous.kind !== change.kind ||
          stableJson(previous.pointer) !== stableJson(change.pointer)
        )
          throw new CatalogFault("conflict");
        return {
          identity,
          revision: previous.revision.toString(),
          publicationId: previous.publicationId,
          readable: true,
        };
      }
      const [target] = await tx
        .select()
        .from(publications)
        .where(
          and(eq(publications.id, change.targetPublicationId), scopeWhere(publications, identity)),
        );
      if (!target) throw new CatalogFault("conflict");
      const [current] = await tx
        .select()
        .from(channels)
        .where(scopeWhere(channels, identity))
        .for("update");
      const revision = current?.revision ?? 0n;
      if (revision.toString() !== change.expectedRevision || revision === 9223372036854775807n)
        throw new CatalogFault("conflict");
      const [previousPublication] = current?.publicationId
        ? await tx.select().from(publications).where(eq(publications.id, current.publicationId))
        : [];
      authority?.beforeCommit(target, previousPublication ?? null);
      await this.addReceipt(tx, receipt, "channel");
      await tx.insert(events).values({
        id: change.operationId,
        ...identity,
        expectedRevision: revision,
        revision: revision + 1n,
        previousPublicationId: current?.publicationId ?? null,
        publicationId: target.id,
        kind: change.kind,
        receiptId: receipt.operationId,
        pointer: change.pointer,
      });
      const next = { revision: revision + 1n, publicationId: target.id, readable: true };
      await tx
        .insert(channels)
        .values({ ...identity, ...next })
        .onConflictDoUpdate({ target: [channels.product, channels.channel], set: next });
      await this.audit.record(tx, {
        ...actor,
        action: "release_catalog.channel.change",
        outcome: "success",
        tenantId: null,
        targetType: "release_catalog_channel",
        targetId: `${identity.product}/${identity.channel}`,
        reason: change.kind,
        before: { revision: revision.toString(), publicationId: current?.publicationId ?? null },
        after: {
          revision: next.revision.toString(),
          publicationId: target.id,
          operationId: change.operationId,
          ...(authority?.principal ? { principalHash: authority.principal.fingerprint } : {}),
        },
        requestId: actor.requestId,
      });
      return { identity, ...next, revision: next.revision.toString() };
    });
  }
}
