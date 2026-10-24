import { z } from "zod";
import {
  catalogIntentViewSchema,
  catalogPublicationResultSchema,
  channelChangeRequestSchema,
  channelSnapshotSchema,
  publicationCommitRequestSchema,
  publicationRequestSchema,
  type PublicationRequest,
  type ReleaseProduct,
} from "@markiro/platform-contracts";
import type { PlatformAuditEvent } from "../../platform-auth/platform-audit.service";
import type { CatalogRepository, CatalogPrincipal, PublicationRow } from "./catalog-repository";
import type { CatalogLedger } from "./catalog-ledger";
import type { VerifiedCache, VerifiedFile } from "./catalog-cache";
import { CatalogFault, type PinnedObject, type VerifiedInputFile } from "./catalog-types";
import {
  assertProductPublication,
  assertStationPromotion,
  compareCatalogVersions,
  type ProductAcceptance,
} from "./catalog-product";
import { derivePublicPath, deriveUploadKey } from "./catalog-policy";
import { digest } from "./catalog-receipts";
export interface CatalogCaller {
  principal: CatalogPrincipal;
  product: Exclude<ReleaseProduct, "signer">;
  machine: boolean;
  expiresAt: number;
  actor: Pick<PlatformAuditEvent, "actorPlatformUserId" | "actorRole" | "requestId">;
}
export interface CatalogServiceOptions {
  repository: CatalogRepository;
  ledger: CatalogLedger;
  cache: Pick<VerifiedCache, "acquire">;
  bucket: string;
  /** Must reload mutable platform membership/capability, or recheck pinned machine identity. */
  authorize(caller: CatalogCaller, action: "read" | "publish" | "channel"): Promise<void>;
  now?: () => number;
}
const metadataSchema = z
  .object({
    product: z.enum(["station", "handheld", "standalone"]),
    version: z.string(),
    sourceSha: z.string(),
    pointer: z.record(z.string(), z.unknown()),
    versionCode: z.number().int().positive().optional(),
    protocol: z.number().int().positive().optional(),
    minProtocol: z.number().int().positive().optional(),
    minUpgradeFrom: z.string().optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new CatalogFault("invalid_request");
  return result.data;
}
function metadata(row: PublicationRow): ProductAcceptance {
  const result = metadataSchema.safeParse(row.metadata);
  if (
    !result.success ||
    result.data.product !== row.product ||
    result.data.version !== row.version ||
    result.data.sourceSha !== row.sourceSha
  )
    throw new CatalogFault("not_ready");
  // Optional properties stay absent, rather than explicit undefined, at the strict interface.
  const m = result.data;
  return {
    product: m.product,
    version: m.version,
    sourceSha: m.sourceSha,
    pointer: m.pointer,
    ...(m.versionCode === undefined ? {} : { versionCode: m.versionCode }),
    ...(m.protocol === undefined ? {} : { protocol: m.protocol }),
    ...(m.minProtocol === undefined ? {} : { minProtocol: m.minProtocol }),
    ...(m.minUpgradeFrom === undefined ? {} : { minUpgradeFrom: m.minUpgradeFrom }),
    ...(m.evidence === undefined ? {} : { evidence: m.evidence }),
  };
}
function semantic(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(semantic).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${semantic(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export class CatalogService {
  private readonly now: () => number;
  constructor(private readonly options: CatalogServiceOptions) {
    this.now = options.now ?? Date.now;
  }
  private live(caller: CatalogCaller, product: string) {
    if (
      caller.product !== product ||
      caller.expiresAt <= this.now() ||
      !Number.isFinite(caller.expiresAt)
    )
      throw new CatalogFault("forbidden");
  }
  private async authorize(
    caller: CatalogCaller,
    product: string,
    action: "read" | "publish" | "channel",
  ) {
    this.live(caller, product);
    await this.options.authorize(caller, action);
    this.live(caller, product);
  }
  private intentView(intent: Awaited<ReturnType<CatalogRepository["getIntent"]>>) {
    return catalogIntentViewSchema.parse({
      id: intent.id,
      identity: intent.request.identity,
      state: intent.state,
      expiresAt: intent.expiresAt.toISOString(),
      files: intent.request.files.map((f) => ({
        ...f,
        key: deriveUploadKey(intent.product, intent.id, f.name),
      })),
    });
  }
  async createIntent(caller: CatalogCaller, idempotencyKey: unknown, input: unknown) {
    const request = parse(publicationRequestSchema, input);
    await this.authorize(caller, request.identity.product, "publish");
    return this.intentView(
      await this.options.repository.reserveIntent(caller.principal, idempotencyKey, request),
    );
  }
  async getIntent(caller: CatalogCaller, id: string) {
    await this.authorize(caller, caller.product, "read");
    const intent = await this.options.repository.getIntent(caller.principal, id);
    this.live(caller, intent.product);
    return this.intentView(intent);
  }
  private async verify(request: PublicationRequest, objects: PinnedObject[]) {
    const leases: VerifiedFile[] = [],
      files = new Map<string, VerifiedInputFile>();
    try {
      for (const spec of request.files) {
        const object = objects.find(
          (f) => f.publicPath === derivePublicPath(request.identity, spec.name),
        );
        if (
          !object ||
          object.sha256 !== spec.sha256 ||
          object.sizeBytes !== spec.sizeBytes ||
          object.contentType !== spec.contentType ||
          object.bucket !== this.options.bucket
        )
          throw new CatalogFault("conflict");
        const lease = await this.options.cache.acquire(object);
        leases.push(lease);
        files.set(spec.name, {
          spec,
          sha256: lease.sha256,
          sizeBytes: lease.size,
          read: (maximum) => lease.read(maximum),
        });
      }
      const accepted = await assertProductPublication(request, files);
      if (request.identity.product === "station" && request.identity.channel === "stable") {
        const betaVersion = accepted.evidence?.betaVersion;
        if (typeof betaVersion !== "string") throw new CatalogFault("conflict");
        const beta = await this.options.repository.publicationByIdentity({
          product: "station",
          channel: "beta",
          version: betaVersion,
        });
        if (!beta) throw new CatalogFault("not_ready");
        assertStationPromotion(
          accepted,
          metadata(beta.publication),
          new Map(request.files.map((f) => [f.name, f.sha256])),
          new Map(beta.files.map((f) => [f.name, f.sha256])),
        );
      }
      return accepted;
    } finally {
      for (const lease of leases) await lease.close();
    }
  }
  private async loadPrepared(id: string) {
    try {
      return await this.options.ledger.load(id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  private async result(id: string) {
    const found = await this.options.repository.publication(id);
    return catalogPublicationResultSchema.parse({
      publicationId: id,
      identity: found.request.identity,
      files: found.files.map((f) => ({
        name: f.name,
        publicPath: f.publicPath,
        versionId: f.versionId,
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
        contentType: f.contentType,
      })),
    });
  }
  async commitIntent(caller: CatalogCaller, id: string, input: unknown) {
    const uploaded = parse(publicationCommitRequestSchema, input);
    await this.authorize(caller, caller.product, "publish");
    const { repository, ledger, bucket } = this.options;
    const intent = await repository.getIntent(caller.principal, id),
      request = intent.request;
    this.live(caller, intent.product);
    if (
      uploaded.files.length !== request.files.length ||
      request.files.some((f) => !uploaded.files.some((u) => u.name === f.name))
    )
      throw new CatalogFault("conflict");
    const existing = await repository.publicationByIntent(id);
    if (existing) {
      await ledger.confirmCommitted(existing.publication.receiptId, {
        kind: "publication",
        publicationId: existing.publication.id,
      });
      return this.result(existing.publication.id);
    }
    if (
      intent.expiresAt.getTime() <= this.now() ||
      intent.state === "failed" ||
      intent.state === "committed"
    )
      throw new CatalogFault("not_ready");
    const prepared = await this.loadPrepared(id);
    let objects: PinnedObject[];
    if (prepared) {
      if (
        prepared.kind !== "publication" ||
        prepared.epoch !== intent.epochId ||
        prepared.requestDigest !== intent.requestDigest ||
        prepared.sourceSha !== request.sourceSha ||
        semantic(prepared.identity) !== semantic(request.identity)
      )
        throw new CatalogFault("conflict");
      objects = prepared.files;
    } else
      objects = request.files.map((f) => {
        const upload = uploaded.files.find((u) => u.name === f.name);
        if (!upload) throw new CatalogFault("conflict");
        return {
          publicPath: derivePublicPath(request.identity, f.name),
          bucket,
          key: deriveUploadKey(intent.product, id, f.name),
          versionId: upload.versionId,
          sha256: f.sha256,
          sizeBytes: f.sizeBytes,
          contentType: f.contentType,
        };
      });
    const accepted = await this.verify(request, objects);
    const receipt = await ledger.prepare({
      schema: 1,
      id,
      kind: "publication",
      epoch: intent.epochId,
      identity: request.identity,
      requestDigest: intent.requestDigest,
      sourceSha: request.sourceSha,
      files: objects,
    });
    await this.authorize(caller, intent.product, "publish");
    const result = await repository.commitPublication(
      caller.principal,
      id,
      intent.epochId,
      { metadata: accepted, objects },
      receipt,
      caller.actor,
      (registered) => {
        this.live(caller, intent.product);
        for (const previous of registered) {
          const old = metadata(previous);
          if (
            intent.product === "handheld" &&
            (accepted.versionCode === undefined ||
              old.versionCode === undefined ||
              accepted.versionCode <= old.versionCode)
          )
            throw new CatalogFault("conflict");
          if (
            intent.product !== "handheld" &&
            compareCatalogVersions(accepted.version, old.version) <= 0
          )
            throw new CatalogFault("conflict");
        }
      },
    );
    await ledger.confirmCommitted(receipt.operationId, {
      kind: "publication",
      publicationId: result.publication.id,
    });
    return this.result(result.publication.id);
  }
  async changeChannel(caller: CatalogCaller, scope: unknown, input: unknown) {
    const identity = parse(channelSnapshotSchema.shape.identity, scope),
      change = parse(channelChangeRequestSchema, input);
    await this.authorize(caller, identity.product, "channel");
    const { repository, ledger } = this.options;
    const epoch = await repository.activeEpoch(identity),
      target = await repository.publication(change.targetPublicationId);
    if (
      target.publication.product !== identity.product ||
      target.publication.channel !== identity.channel
    )
      throw new CatalogFault("conflict");
    if (caller.machine) await repository.getIntent(caller.principal, target.publication.intentId);
    const previousEvent = await repository.channelEvent(change.operationId);
    if (previousEvent) {
      if (
        previousEvent.product !== identity.product ||
        previousEvent.channel !== identity.channel ||
        previousEvent.expectedRevision.toString() !== change.expectedRevision ||
        previousEvent.publicationId !== change.targetPublicationId ||
        previousEvent.kind !== change.kind
      )
        throw new CatalogFault("conflict");
      await ledger.confirmCommitted(previousEvent.receiptId, {
        kind: "channel",
        publicationId: previousEvent.publicationId,
        revision: previousEvent.revision.toString(),
      });
      return {
        identity,
        revision: previousEvent.revision.toString(),
        publicationId: previousEvent.publicationId,
        readable: true,
      };
    }
    const current = await repository.readChannel(identity);
    if (
      current.revision !== change.expectedRevision ||
      (current.revision !== "0" && !current.readable)
    )
      throw new CatalogFault("conflict");
    const accepted = await this.verify(target.request, target.files);
    if (semantic(accepted) !== semantic(metadata(target.publication)))
      throw new CatalogFault("conflict");
    const validateTransition = (next: PublicationRow, old: PublicationRow | null) => {
      this.live(caller, identity.product);
      const n = metadata(next),
        p = old ? metadata(old) : null;
      if (identity.product === "handheld") {
        if (
          change.kind !== "forward" ||
          n.versionCode === undefined ||
          (p && (p.versionCode === undefined || n.versionCode <= p.versionCode))
        )
          throw new CatalogFault("conflict");
      } else if (p) {
        const order = compareCatalogVersions(n.version, p.version);
        if ((change.kind === "forward" && order <= 0) || (change.kind === "rollback" && order >= 0))
          throw new CatalogFault("conflict");
      } else if (change.kind !== "forward") throw new CatalogFault("conflict");
    };
    const old = current.publicationId ? await repository.publication(current.publicationId) : null;
    validateTransition(target.publication, old?.publication ?? null);
    const bytes = Buffer.from(JSON.stringify(accepted.pointer));
    const receipt = await ledger.prepare({
      schema: 1,
      id: change.operationId,
      kind: "channel",
      epoch,
      identity,
      expectedRevision: change.expectedRevision,
      revision: (BigInt(change.expectedRevision) + 1n).toString(),
      previousPublicationId: current.publicationId,
      publicationId: change.targetPublicationId,
      transition: change.kind,
      pointer: {
        base64: bytes.toString("base64"),
        sha256: digest(bytes),
        sizeBytes: bytes.length,
        contentType: "application/json",
      },
    });
    await this.authorize(caller, identity.product, "channel");
    const result = await repository.commitChannelChange(
      { ...change, identity, epoch, pointer: accepted.pointer },
      receipt,
      caller.actor,
      {
        ...(caller.machine ? { principal: caller.principal } : {}),
        beforeCommit: validateTransition,
      },
    );
    await ledger.confirmCommitted(receipt.operationId, {
      kind: "channel",
      publicationId: change.targetPublicationId,
      revision: result.revision,
    });
    return result;
  }
}
