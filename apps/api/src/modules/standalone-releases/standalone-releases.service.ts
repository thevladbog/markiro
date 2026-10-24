import { HttpException, Inject, Injectable } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import {
  STANDALONE_RELEASE_CHANNELS,
  compareStandaloneReleaseVersions,
  standaloneInstallerFileName,
  standaloneManifestFileName,
  standaloneLatestPointerSchema,
  standaloneReleaseSchema,
  standaloneReleaseUploadRequestSchema,
  standaloneReleaseRegisterRequestSchema,
  standaloneReleaseSetLatestSchema,
  releaseVersionIdSchema,
  type PlatformPrincipal,
  type StandaloneRelease,
  type StandaloneReleaseChannel,
  type StandaloneReleaseChannelView,
  type StandaloneReleaseList,
  type StandaloneReleaseUploadRequest,
  type StandaloneReleaseRegisterRequest,
  type StandaloneReleaseSetLatest,
  type StandaloneReleaseErrorCode,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { CatalogService, type CatalogCaller } from "../release-catalog/catalog-service";
import { CatalogRepository } from "../release-catalog/catalog-repository";
import { CatalogFault } from "../release-catalog/catalog-types";
import { platformCatalogFingerprint } from "../release-catalog/release-catalog.module";
import type { StandaloneReleasesConfig } from "./release-config";
import type { StandaloneReleaseStore } from "./release-store";
export const STANDALONE_RELEASES = Symbol("STANDALONE_RELEASES");
export const STANDALONE_RELEASES_CLOCK = Symbol("STANDALONE_RELEASES_CLOCK");
export const STANDALONE_RELEASE_KEYSET_TOKEN = Symbol("STANDALONE_RELEASE_KEYSET");
export interface StandaloneReleasesRuntime {
  config: StandaloneReleasesConfig;
  store: StandaloneReleaseStore;
}
export function standaloneReleaseError(code: StandaloneReleaseErrorCode): HttpException {
  const status =
    code === "standalone_release_not_found"
      ? 404
      : code.startsWith("standalone_releases_")
        ? 503
        : [
              "standalone_release_version_exists",
              "standalone_release_version_not_newer",
              "standalone_release_immutable",
              "standalone_release_integrity_failed",
              "standalone_release_channel_conflict",
            ].includes(code)
          ? 409
          : 422;
  return new HttpException({ code }, status);
}
@Injectable()
export class StandaloneReleasesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_RELEASES) private readonly runtime: StandaloneReleasesRuntime | null,
    @Inject(CatalogService) private readonly catalog: CatalogService | null,
    private readonly repository: CatalogRepository,
    @Inject(STANDALONE_RELEASES_CLOCK) private readonly now: () => Date,
  ) {}
  private configured() {
    if (!this.runtime || !this.catalog)
      throw standaloneReleaseError("standalone_releases_not_configured");
    if (this.runtime.config.publicOrigin !== "https://releases.markiro.app")
      throw standaloneReleaseError("standalone_releases_storage_unavailable");
    return { runtime: this.runtime, catalog: this.catalog };
  }
  private caller(principal: PlatformPrincipal): CatalogCaller {
    return {
      principal: { fingerprint: platformCatalogFingerprint(principal.userId) },
      product: "standalone",
      machine: false,
      expiresAt: this.now().getTime() + 900000,
      actor: { actorPlatformUserId: principal.userId, actorRole: principal.role, requestId: null },
    };
  }
  private async call<T>(work: () => Promise<T>, channel = false): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof CatalogFault) {
        if (error.detail) throw standaloneReleaseError(error.detail);
        if (error.code === "forbidden") throw new HttpException({ code: "catalog_forbidden" }, 403);
        if (error.code === "invalid_request")
          throw new HttpException({ code: "catalog_invalid_request" }, 400);
        if (error.code === "not_found")
          throw standaloneReleaseError("standalone_release_not_found");
        if (error.code === "conflict")
          throw standaloneReleaseError(
            channel ? "standalone_release_channel_conflict" : "standalone_release_integrity_failed",
          );
      }
      throw standaloneReleaseError("standalone_releases_storage_unavailable");
    }
  }
  private async view(id: string): Promise<StandaloneRelease> {
    const found = await this.repository.publication(id),
      row = found.publication,
      m = row.metadata;
    if (row.product !== "standalone") throw new CatalogFault("not_found");
    const pointer = standaloneLatestPointerSchema.parse(m.pointer);
    const file = (name: string) => {
      const f = found.files.find((f) => f.name === name);
      if (!f) throw new CatalogFault("not_ready");
      return {
        name,
        url: `https://releases.markiro.app${f.publicPath}`,
        sha256: f.sha256,
        sizeBytes: f.sizeBytes,
      };
    };
    return standaloneReleaseSchema.parse({
      channel: row.channel,
      version: row.version,
      registeredAt: row.createdAt.toISOString(),
      releasedAt: new Date(pointer.releasedAt).toISOString(),
      kid: m.kid,
      sourceSha: row.sourceSha,
      protocol: m.protocol,
      minProtocol: m.minProtocol,
      minUpgradeFrom: m.minUpgradeFrom,
      notes: pointer.notes,
      installer: file(standaloneInstallerFileName(row.version)),
      manifest: file(standaloneManifestFileName(row.version)),
    });
  }
  private async channelView(
    caller: CatalogCaller,
    channel: StandaloneReleaseChannel,
  ): Promise<StandaloneReleaseChannelView> {
    const { catalog } = this.configured(),
      scope = { product: "standalone" as const, channel };
    const snapshot = await catalog.getChannel(caller, scope);
    const rows = await this.db
      .select({ id: schema.releaseCatalogPublications.id })
      .from(schema.releaseCatalogPublications)
      .where(
        and(
          eq(schema.releaseCatalogPublications.product, "standalone"),
          eq(schema.releaseCatalogPublications.channel, channel),
        ),
      )
      .limit(1001);
    if (rows.length > 1000) throw new CatalogFault("not_ready");
    const releases = [];
    for (const row of rows) releases.push(await this.view(row.id));
    releases.sort((a, b) => compareStandaloneReleaseVersions(b.version, a.version));
    const pending = await this.db
      .select({
        intentId: schema.releaseCatalogIntents.id,
        version: schema.releaseCatalogIntents.version,
      })
      .from(schema.releaseCatalogIntents)
      .where(
        and(
          eq(schema.releaseCatalogIntents.product, "standalone"),
          eq(schema.releaseCatalogIntents.channel, channel),
          eq(schema.releaseCatalogIntents.ownerFingerprint, caller.principal.fingerprint),
          inArray(schema.releaseCatalogIntents.state, ["pending", "verified"]),
          gt(schema.releaseCatalogIntents.expiresAt, this.now()),
        ),
      )
      .limit(1001);
    if (pending.length > 1000) throw new CatalogFault("not_ready");
    const latest =
      snapshot.readable && snapshot.publicationId
        ? (await this.view(snapshot.publicationId)).version
        : null;
    return {
      channel,
      revision: snapshot.revision,
      latest,
      latestReadable: snapshot.readable,
      releases,
      pending,
    };
  }
  async list(principal: PlatformPrincipal): Promise<StandaloneReleaseList> {
    if (!this.runtime || !this.catalog) return { configured: false };
    return this.call(async () => {
      const caller = this.caller(principal),
        channels = [];
      for (const channel of STANDALONE_RELEASE_CHANNELS)
        channels.push(await this.channelView(caller, channel));
      return { configured: true, publicOrigin: "https://releases.markiro.app", channels };
    });
  }
  async createUpload(principal: PlatformPrincipal, input: StandaloneReleaseUploadRequest) {
    return this.call(async () => {
      const { runtime, catalog } = this.configured(),
        request = standaloneReleaseUploadRequestSchema.parse(input),
        caller = this.caller(principal);
      const names = {
        installer: standaloneInstallerFileName(request.version),
        manifest: standaloneManifestFileName(request.version),
      };
      const intent = await catalog.createIntent(caller, request.idempotencyKey, {
        identity: { product: "standalone", channel: request.channel, version: request.version },
        sourceSha: request.sourceSha,
        files: (["installer", "manifest"] as const).map((kind) => ({
          name: names[kind],
          ...request[kind],
          contentType: "application/octet-stream",
        })),
        evidence: { kind: "standalone", manifestName: names.manifest },
      });
      const ttl = Math.min(
        900,
        Math.floor((Date.parse(intent.expiresAt) - this.now().getTime()) / 1000),
      );
      if (ttl < 1 || intent.state !== "pending") throw new CatalogFault("not_ready");
      await this.db.transaction((tx) =>
        this.audit.record(tx, {
          ...caller.actor,
          action: "standalone_release.upload.authorize",
          outcome: "success",
          tenantId: null,
          targetType: "release_catalog_intent",
          targetId: intent.id,
          reason: null,
          before: null,
          after: {
            channel: request.channel,
            version: request.version,
            sourceSha: request.sourceSha,
          },
        }),
      );
      const target = async (kind: "installer" | "manifest") => {
        const file = intent.files.find((f) => f.name === names[kind]);
        if (!file) throw new CatalogFault("conflict");
        return {
          name: file.name,
          contentType: "application/octet-stream" as const,
          uploadUrl: await runtime.store.presignPut(file.key, "application/octet-stream", ttl),
        };
      };
      return {
        intentId: intent.id,
        channel: request.channel,
        version: request.version,
        expiresAt: intent.expiresAt,
        installer: await target("installer"),
        manifest: await target("manifest"),
      };
    });
  }
  async register(principal: PlatformPrincipal, input: StandaloneReleaseRegisterRequest) {
    return this.call(async () => {
      const { runtime, catalog } = this.configured(),
        { intentId } = standaloneReleaseRegisterRequestSchema.parse(input),
        caller = this.caller(principal);
      const intent = await catalog.getIntent(caller, intentId);
      const existing = await this.repository.publicationByIntent(intentId);
      try {
        const files = [];
        if (existing)
          for (const f of existing.files) files.push({ name: f.name, versionId: f.versionId });
        else
          for (const f of intent.files) {
            const head = await runtime.store.headVersion(f.key);
            if (!head) throw standaloneReleaseError("standalone_release_files_missing");
            if (head.size !== f.sizeBytes)
              throw standaloneReleaseError("standalone_release_integrity_failed");
            files.push({ name: f.name, versionId: releaseVersionIdSchema.parse(head.versionId) });
          }
        const result = await catalog.commitIntent(caller, intentId, { files });
        return {
          outcome: existing ? ("unchanged" as const) : ("registered" as const),
          release: await this.view(result.publicationId),
        };
      } catch (error) {
        // Evidence is retained, including rejected uploads. Never delete a staged object/version.
        await this.db.transaction((tx) =>
          this.audit.record(tx, {
            ...caller.actor,
            action: "standalone_release.register",
            outcome: "denied",
            tenantId: null,
            targetType: "release_catalog_intent",
            targetId: intentId,
            reason: error instanceof CatalogFault ? error.code : "unavailable",
            before: null,
            after: null,
          }),
        );
        throw error;
      }
    });
  }
  async setLatest(
    principal: PlatformPrincipal,
    channel: StandaloneReleaseChannel,
    input: StandaloneReleaseSetLatest,
  ) {
    return this.call(async () => {
      const { catalog } = this.configured(),
        change = standaloneReleaseSetLatestSchema.parse(input),
        caller = this.caller(principal),
        scope = { product: "standalone" as const, channel };
      // Recheck platform membership before looking up the target, and again inside the service mutation.
      await catalog.getChannel(caller, scope);
      const target = await this.repository.publicationByIdentity({
        ...scope,
        version: change.version,
      });
      if (!target) throw new CatalogFault("not_found");
      await catalog.changeChannel(caller, scope, {
        operationId: change.operationId,
        expectedRevision: change.expectedRevision,
        targetPublicationId: target.publication.id,
        kind: change.kind,
      });
      return this.channelView(caller, channel);
    }, true);
  }
}
