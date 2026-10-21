import { createHash } from "node:crypto";
import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { type Db, type PlatformRole } from "@markiro/db";
import {
  STANDALONE_UPDATE_MANIFEST_MAX_BYTES,
  verifyStandaloneUpdateManifest,
  type StandaloneUpdateKeyset,
  type StandaloneUpdateManifestV1,
} from "@markiro/domain";
import {
  STANDALONE_RELEASE_CHANNELS,
  STANDALONE_RELEASE_PRODUCT,
  STANDALONE_RELEASE_PREFIX,
  compareStandaloneReleaseVersions,
  standaloneInstallerFileName,
  standaloneLatestObjectKey,
  standaloneLatestPointerSchema,
  standaloneManifestFileName,
  standaloneReleaseObjectKey,
  standaloneReleaseVersionSchema,
  type PlatformPrincipal,
  type StandaloneLatestPointer,
  type StandaloneRelease,
  type StandaloneReleaseChannel,
  type StandaloneReleaseChannelView,
  type StandaloneReleaseErrorCode,
  type StandaloneReleaseList,
  type StandaloneReleaseRegistration,
  type StandaloneReleaseTarget,
  type StandaloneReleaseUpload,
} from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import type { StandaloneReleasesConfig } from "./release-config";
import { ReleaseObjectTooLargeError, type StandaloneReleaseStore } from "./release-store";

export const STANDALONE_RELEASES = Symbol("STANDALONE_RELEASES");
export const STANDALONE_RELEASE_KEYSET_TOKEN = Symbol("STANDALONE_RELEASE_KEYSET");
export const STANDALONE_RELEASES_CLOCK = Symbol("STANDALONE_RELEASES_CLOCK");

/** The configured bucket, or `null`: the section then answers «не настроено». */
export interface StandaloneReleasesRuntime {
  config: StandaloneReleasesConfig;
  store: StandaloneReleaseStore;
}

/** The host refuses a larger installer (`markiro_proto::update::MAX_INSTALLER_BYTES`). */
export const STANDALONE_INSTALLER_MAX_BYTES = 256 * 1024 * 1024;
const UPLOAD_EXPIRES_SECONDS = 15 * 60;
const UPLOAD_CONTENT_TYPE = "application/octet-stream";
const RECORD_NAME = "release.json";
const RECORD_MAX_BYTES = 64 * 1024;
const TARGET_TYPE = "standalone_release";
// Distinct from the billing workflow namespaces (`BILP`, `BILT`).
const LOCK_NAMESPACE = 0x53524c53; // "SRLS"
const CHANNEL_LOCK: Record<StandaloneReleaseChannel, number> = { stable: 1, beta: 2 };

const STATUS: Record<StandaloneReleaseErrorCode, 404 | 409 | 422 | 503> = {
  standalone_releases_not_configured: 503,
  standalone_releases_storage_unavailable: 503,
  standalone_release_version_exists: 409,
  standalone_release_version_not_newer: 409,
  standalone_release_files_missing: 422,
  standalone_release_installer_too_large: 422,
  standalone_release_manifest_malformed: 422,
  standalone_release_manifest_unknown_key: 422,
  standalone_release_manifest_bad_signature: 422,
  standalone_release_manifest_mismatch: 422,
  standalone_release_installer_size_mismatch: 422,
  standalone_release_installer_hash_mismatch: 422,
  standalone_release_immutable: 409,
  standalone_release_not_found: 404,
  standalone_release_integrity_failed: 409,
};

export function standaloneReleaseError(code: StandaloneReleaseErrorCode): HttpException {
  const body = { code };
  switch (STATUS[code]) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 422:
      return new UnprocessableEntityException(body);
    case 503:
      return new ServiceUnavailableException(body);
  }
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const fileRecordSchema = z
  .object({
    name: z.string().min(1).max(128),
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
  })
  .strict();
/**
 * `standalone/<channel>/<version>/release.json`: written once, after the checks
 * pass, and the only proof that a version is registered. It is public (the
 * whole prefix is), so it names no person.
 */
const releaseRecordSchema = z
  .object({
    v: z.literal(1),
    product: z.literal(STANDALONE_RELEASE_PRODUCT),
    channel: z.enum(STANDALONE_RELEASE_CHANNELS),
    version: standaloneReleaseVersionSchema,
    releasedAt: z.string(),
    registeredAt: z.string(),
    kid: z.string().min(1).max(128),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    protocol: z.number().int().positive(),
    minProtocol: z.number().int().positive(),
    minUpgradeFrom: standaloneReleaseVersionSchema,
    notes: z.array(z.string()).max(30),
    installer: fileRecordSchema,
    manifest: fileRecordSchema,
  })
  .strict();
type ReleaseRecord = z.infer<typeof releaseRecordSchema>;

type Actor = { userId: string; role: PlatformRole };
type Verified =
  | { ok: true; outcome: "registered" | "unchanged"; record: ReleaseRecord }
  | { ok: false; code: StandaloneReleaseErrorCode; registered: boolean; observed: Observed };
type Observed = Partial<{
  kid: string;
  manifestSha256: string;
  manifestVersion: string;
  manifestChannel: string;
  installerSha256: string;
  installerSizeBytes: number;
  expectedSha256: string;
  expectedSizeBytes: number;
  newestVersion: string;
}>;

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const MANIFEST_FAILURE: Record<string, StandaloneReleaseErrorCode> = {
  malformed: "standalone_release_manifest_malformed",
  unknown_key: "standalone_release_manifest_unknown_key",
  bad_signature: "standalone_release_manifest_bad_signature",
};

@Injectable()
export class StandaloneReleasesService {
  readonly #logger = new Logger(StandaloneReleasesService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    @Inject(STANDALONE_RELEASES) private readonly runtime: StandaloneReleasesRuntime | null,
    @Inject(STANDALONE_RELEASE_KEYSET_TOKEN) private readonly keyset: StandaloneUpdateKeyset,
    @Inject(STANDALONE_RELEASES_CLOCK) private readonly now: () => Date,
  ) {}

  async list(): Promise<StandaloneReleaseList> {
    if (!this.runtime) return { configured: false };
    const channels = await this.#storage(() =>
      Promise.all(STANDALONE_RELEASE_CHANNELS.map((channel) => this.#channelView(channel))),
    );
    return { configured: true, publicOrigin: this.runtime.config.publicOrigin, channels };
  }

  /** Presigned PUTs into the version's immutable folder (spec §5.4). Refused once registered. */
  async createUpload(
    principal: PlatformPrincipal,
    target: StandaloneReleaseTarget,
  ): Promise<StandaloneReleaseUpload> {
    const { store } = this.#configured();
    const { channel, version } = target;
    const [record, newest] = await this.#storage(() =>
      Promise.all([this.#readRecord(channel, version), this.#newestRegistered(channel)]),
    );
    if (record) throw standaloneReleaseError("standalone_release_version_exists");
    if (newest !== null && compareStandaloneReleaseVersions(version, newest) <= 0)
      throw standaloneReleaseError("standalone_release_version_not_newer");
    const installer = standaloneInstallerFileName(version);
    const manifest = standaloneManifestFileName(version);
    const [installerUrl, manifestUrl] = await this.#storage(() =>
      Promise.all(
        [installer, manifest].map((name) =>
          store.presignPut(
            standaloneReleaseObjectKey(channel, version, name),
            UPLOAD_CONTENT_TYPE,
            UPLOAD_EXPIRES_SECONDS,
          ),
        ),
      ),
    );
    const expiresAt = new Date(this.now().getTime() + UPLOAD_EXPIRES_SECONDS * 1000);
    await this.db.transaction((tx) =>
      this.audit.record(tx, {
        ...this.#auditBase(principal, channel, version),
        action: "standalone.release.upload.authorize",
        outcome: "success",
        reason: null,
        before: null,
        after: { channel, version, expiresAt: expiresAt.toISOString() },
      }),
    );
    return {
      channel,
      version,
      expiresAt: expiresAt.toISOString(),
      installer: { name: installer, uploadUrl: installerUrl!, contentType: UPLOAD_CONTENT_TYPE },
      manifest: { name: manifest, uploadUrl: manifestUrl!, contentType: UPLOAD_CONTENT_TYPE },
    };
  }

  /**
   * Reads both uploaded objects back and registers the version only if the
   * manifest is signed by a release key, names this channel and version, is
   * newer than every registered version, and the installer's bytes are the ones
   * it signs (spec §5.2 step 3). The panel's word counts for nothing.
   */
  async register(
    principal: PlatformPrincipal,
    target: StandaloneReleaseTarget,
  ): Promise<StandaloneReleaseRegistration> {
    const runtime = this.#configured();
    const { channel, version } = target;
    const verified = await this.#storage(() =>
      this.db.transaction(async (tx) => {
        await this.#lock(tx, channel);
        const result = await this.#verify(channel, version);
        if (result.ok && result.outcome === "registered") {
          await runtime.store.put(
            standaloneReleaseObjectKey(channel, version, RECORD_NAME),
            Buffer.from(`${JSON.stringify(result.record)}\n`),
            "application/json",
            "public, max-age=31536000, immutable",
          );
          await this.audit.record(tx, {
            ...this.#auditBase(principal, channel, version),
            action: "standalone.release.register",
            outcome: "success",
            reason: null,
            before: null,
            after: {
              channel,
              version,
              kid: result.record.kid,
              installerSha256: result.record.installer.sha256,
              installerSizeBytes: result.record.installer.sizeBytes,
              manifestSha256: result.record.manifest.sha256,
              sourceSha: result.record.sourceSha,
            },
          });
        }
        if (!result.ok) {
          await this.audit.record(tx, {
            ...this.#auditBase(principal, channel, version),
            action: "standalone.release.register",
            outcome: "rejected",
            reason: result.code,
            before: null,
            after: { channel, version, ...result.observed },
          });
        }
        return result;
      }),
    );
    if (!verified.ok) {
      // A refused upload of an unregistered version must not linger in the
      // public bucket under a plausible name. A registered version is kept.
      if (!verified.registered) await this.#discard(channel, version);
      throw standaloneReleaseError(verified.code);
    }
    return { outcome: verified.outcome, release: this.#view(verified.record) };
  }

  /**
   * Points `latest.json` at a registered version: forward, or back for a
   * rollback. The files are re-verified first, so a pointer never moves to
   * bytes that changed since registration or to a key since retired.
   */
  async setLatest(
    principal: PlatformPrincipal,
    channel: StandaloneReleaseChannel,
    version: string,
  ): Promise<StandaloneReleaseChannelView> {
    const runtime = this.#configured();
    const outcome = await this.#storage(() =>
      this.db.transaction(async (tx) => {
        await this.#lock(tx, channel);
        const record = await this.#readRecord(channel, version);
        const previous = (await this.#readLatest(channel)).pointer?.version ?? null;
        const failure: StandaloneReleaseErrorCode | null = !record
          ? "standalone_release_not_found"
          : (await this.#intact(record))
            ? null
            : "standalone_release_integrity_failed";
        if (failure || !record) {
          await this.audit.record(tx, {
            ...this.#auditBase(principal, channel, version),
            action: "standalone.release.latest.set",
            outcome: "rejected",
            reason: failure,
            before: { version: previous },
            after: { channel, version },
          });
          return { ok: false as const, code: failure ?? "standalone_release_not_found" };
        }
        if (previous === version) return { ok: true as const };
        const pointer = this.#pointer(record);
        await runtime.store.put(
          standaloneLatestObjectKey(channel),
          Buffer.from(`${JSON.stringify(pointer, null, 2)}\n`),
          "application/json",
          "no-cache",
        );
        await this.audit.record(tx, {
          ...this.#auditBase(principal, channel, version),
          action: "standalone.release.latest.set",
          outcome: "success",
          reason: null,
          before: { version: previous },
          after: {
            channel,
            version,
            direction:
              previous !== null && compareStandaloneReleaseVersions(version, previous) < 0
                ? "rollback"
                : "promote",
            installerSha256: record.installer.sha256,
          },
        });
        return { ok: true as const };
      }),
    );
    if (!outcome.ok) throw standaloneReleaseError(outcome.code);
    return this.#storage(() => this.#channelView(channel));
  }

  /** The version `standalone/<channel>/latest.json` points at, for the diagnostics overview. */
  async latestVersion(channel: StandaloneReleaseChannel): Promise<string | null> {
    if (!this.runtime) return null;
    return (await this.#readLatest(channel)).pointer?.version ?? null;
  }

  async #verify(channel: StandaloneReleaseChannel, version: string): Promise<Verified> {
    const { store } = this.#configured();
    const installerKey = standaloneReleaseObjectKey(
      channel,
      version,
      standaloneInstallerFileName(version),
    );
    const manifestKey = standaloneReleaseObjectKey(
      channel,
      version,
      standaloneManifestFileName(version),
    );
    const existing = await this.#readRecord(channel, version);
    const refuse = (code: StandaloneReleaseErrorCode, observed: Observed = {}): Verified => ({
      ok: false,
      code,
      registered: existing !== null,
      observed,
    });

    const manifestBytes = await this.#readBounded(
      manifestKey,
      STANDALONE_UPDATE_MANIFEST_MAX_BYTES,
    );
    const installerHead = await store.head(installerKey);
    if (existing) {
      // Paths are immutable: a registered version only ever matches itself.
      const installer = installerHead ? await this.#digestBounded(installerKey) : null;
      const same =
        manifestBytes !== "too_large" &&
        manifestBytes !== null &&
        sha256(manifestBytes) === existing.manifest.sha256 &&
        installer !== null &&
        installer !== "too_large" &&
        installer.sha256 === existing.installer.sha256 &&
        installer.size === existing.installer.sizeBytes;
      return same
        ? { ok: true, outcome: "unchanged", record: existing }
        : refuse("standalone_release_immutable", {
            expectedSha256: existing.installer.sha256,
            ...(installer && installer !== "too_large"
              ? { installerSha256: installer.sha256 }
              : {}),
          });
    }

    if (manifestBytes === null || !installerHead) return refuse("standalone_release_files_missing");
    if (manifestBytes === "too_large") return refuse("standalone_release_manifest_malformed");
    const manifestSha256 = sha256(manifestBytes);
    const text = decodeUtf8(manifestBytes);
    if (text === null) return refuse("standalone_release_manifest_malformed", { manifestSha256 });
    const verification = await verifyStandaloneUpdateManifest(text.trim(), this.keyset);
    if (!verification.ok)
      return refuse(
        MANIFEST_FAILURE[verification.reason] ?? "standalone_release_manifest_malformed",
        {
          manifestSha256,
        },
      );
    const { manifest, kid } = verification;
    const observed: Observed = {
      kid,
      manifestSha256,
      manifestVersion: manifest.version,
      manifestChannel: manifest.channel,
    };
    if (
      manifest.product !== STANDALONE_RELEASE_PRODUCT ||
      manifest.channel !== channel ||
      manifest.version !== version ||
      manifest.installer.name !== standaloneInstallerFileName(version)
    )
      return refuse("standalone_release_manifest_mismatch", observed);

    const newest = await this.#newestRegistered(channel);
    if (newest !== null && compareStandaloneReleaseVersions(version, newest) <= 0)
      return refuse("standalone_release_version_not_newer", { ...observed, newestVersion: newest });

    const expected = {
      expectedSha256: manifest.installer.sha256,
      expectedSizeBytes: manifest.installer.sizeBytes,
    };
    if (manifest.installer.sizeBytes > STANDALONE_INSTALLER_MAX_BYTES)
      return refuse("standalone_release_installer_too_large", { ...observed, ...expected });
    if (installerHead.size !== manifest.installer.sizeBytes)
      return refuse("standalone_release_installer_size_mismatch", {
        ...observed,
        ...expected,
        installerSizeBytes: installerHead.size,
      });
    const installer = await this.#digestBounded(installerKey);
    if (installer === "too_large")
      return refuse("standalone_release_installer_too_large", { ...observed, ...expected });
    if (!installer) return refuse("standalone_release_files_missing", observed);
    const measured = { installerSha256: installer.sha256, installerSizeBytes: installer.size };
    if (installer.size !== manifest.installer.sizeBytes)
      return refuse("standalone_release_installer_size_mismatch", {
        ...observed,
        ...expected,
        ...measured,
      });
    if (installer.sha256 !== manifest.installer.sha256)
      return refuse("standalone_release_installer_hash_mismatch", {
        ...observed,
        ...expected,
        ...measured,
      });

    return {
      ok: true,
      outcome: "registered",
      record: this.#record(manifest, kid, manifestSha256, manifestBytes.byteLength),
    };
  }

  /** The stored bytes still equal the registration, and the manifest still verifies. */
  async #intact(record: ReleaseRecord): Promise<boolean> {
    const { channel, version } = record;
    const manifest = await this.#readBounded(
      standaloneReleaseObjectKey(channel, version, record.manifest.name),
      STANDALONE_UPDATE_MANIFEST_MAX_BYTES,
    );
    if (manifest === null || manifest === "too_large") return false;
    if (sha256(manifest) !== record.manifest.sha256) return false;
    const text = decodeUtf8(manifest);
    if (text === null || !(await verifyStandaloneUpdateManifest(text.trim(), this.keyset)).ok)
      return false;
    const installer = await this.#digestBounded(
      standaloneReleaseObjectKey(channel, version, record.installer.name),
    );
    return (
      installer !== null &&
      installer !== "too_large" &&
      installer.sha256 === record.installer.sha256 &&
      installer.size === record.installer.sizeBytes
    );
  }

  #record(
    manifest: StandaloneUpdateManifestV1,
    kid: string,
    manifestSha256: string,
    manifestSize: number,
  ): ReleaseRecord {
    return {
      v: 1,
      product: STANDALONE_RELEASE_PRODUCT,
      channel: manifest.channel,
      version: manifest.version,
      releasedAt: manifest.releasedAt,
      registeredAt: this.now().toISOString(),
      kid,
      sourceSha: manifest.sourceSha,
      protocol: manifest.protocol,
      minProtocol: manifest.minProtocol,
      minUpgradeFrom: manifest.minUpgradeFrom,
      notes: [...manifest.notes],
      installer: {
        name: manifest.installer.name,
        sha256: manifest.installer.sha256,
        sizeBytes: manifest.installer.sizeBytes,
      },
      manifest: {
        name: standaloneManifestFileName(manifest.version),
        sha256: manifestSha256,
        sizeBytes: manifestSize,
      },
    };
  }

  /** `latest.json` (spec §5.3): the manifest's facts and public links. */
  #pointer(record: ReleaseRecord): StandaloneLatestPointer {
    return standaloneLatestPointerSchema.parse({
      v: 1,
      product: STANDALONE_RELEASE_PRODUCT,
      channel: record.channel,
      version: record.version,
      releasedAt: record.releasedAt,
      installer: {
        url: this.#publicUrl(record.channel, record.version, record.installer.name),
        sha256: record.installer.sha256,
        sizeBytes: record.installer.sizeBytes,
      },
      manifestUrl: this.#publicUrl(record.channel, record.version, record.manifest.name),
      notes: record.notes,
    });
  }

  #view(record: ReleaseRecord): StandaloneRelease {
    const file = (entry: ReleaseRecord["installer"]) => ({
      ...entry,
      url: this.#publicUrl(record.channel, record.version, entry.name),
    });
    return {
      channel: record.channel,
      version: record.version,
      releasedAt: new Date(record.releasedAt).toISOString(),
      registeredAt: new Date(record.registeredAt).toISOString(),
      kid: record.kid,
      sourceSha: record.sourceSha,
      protocol: record.protocol,
      minProtocol: record.minProtocol,
      minUpgradeFrom: record.minUpgradeFrom,
      notes: record.notes,
      installer: file(record.installer),
      manifest: file(record.manifest),
    };
  }

  #publicUrl(channel: StandaloneReleaseChannel, version: string, name: string): string {
    const origin = this.#configured().config.publicOrigin;
    return `${origin}/${standaloneReleaseObjectKey(channel, version, name)}`;
  }

  async #channelView(channel: StandaloneReleaseChannel): Promise<StandaloneReleaseChannelView> {
    const versions = await this.#versionFolders(channel);
    const [records, latest] = await Promise.all([
      Promise.all(
        versions.map(
          async (version) => [version, await this.#readRecord(channel, version)] as const,
        ),
      ),
      this.#readLatest(channel),
    ]);
    const releases = records
      .flatMap(([, record]) => (record ? [record] : []))
      .map((record) => this.#view(record));
    const pending = records.flatMap(([version, record]) => (record ? [] : [version]));
    return {
      channel,
      latest: latest.pointer?.version ?? null,
      latestReadable: latest.readable,
      releases,
      pending,
    };
  }

  /** Version folders of a channel, newest first. */
  async #versionFolders(channel: StandaloneReleaseChannel): Promise<string[]> {
    const folders = await this.#configured().store.listFolders(
      `${STANDALONE_RELEASE_PREFIX}/${channel}/`,
    );
    return folders
      .filter((name) => standaloneReleaseVersionSchema.safeParse(name).success)
      .sort((left, right) => compareStandaloneReleaseVersions(right, left));
  }

  async #newestRegistered(channel: StandaloneReleaseChannel): Promise<string | null> {
    for (const version of await this.#versionFolders(channel))
      if (await this.#readRecord(channel, version)) return version;
    return null;
  }

  async #readRecord(
    channel: StandaloneReleaseChannel,
    version: string,
  ): Promise<ReleaseRecord | null> {
    const bytes = await this.#readBounded(
      standaloneReleaseObjectKey(channel, version, RECORD_NAME),
      RECORD_MAX_BYTES,
    );
    if (bytes === null) return null;
    const parsed = bytes === "too_large" ? null : parseJson(bytes, releaseRecordSchema);
    // Only this API writes the record; one it cannot read is a broken bucket, not
    // a missing registration, so it must not be treated as free to overwrite.
    if (!parsed || parsed.channel !== channel || parsed.version !== version)
      throw new Error("Unreadable standalone release record");
    return parsed;
  }

  async #readLatest(
    channel: StandaloneReleaseChannel,
  ): Promise<{ pointer: StandaloneLatestPointer | null; readable: boolean }> {
    const bytes = await this.#readBounded(standaloneLatestObjectKey(channel), RECORD_MAX_BYTES);
    if (bytes === null) return { pointer: null, readable: true };
    const pointer = bytes === "too_large" ? null : parseJson(bytes, standaloneLatestPointerSchema);
    return pointer && pointer.channel === channel
      ? { pointer, readable: true }
      : { pointer: null, readable: false };
  }

  async #readBounded(key: string, maxBytes: number): Promise<Buffer | null | "too_large"> {
    try {
      return await this.#configured().store.read(key, maxBytes);
    } catch (error) {
      if (error instanceof ReleaseObjectTooLargeError) return "too_large";
      throw error;
    }
  }

  async #digestBounded(
    key: string,
  ): Promise<{ sha256: string; size: number } | null | "too_large"> {
    try {
      return await this.#configured().store.digest(key, STANDALONE_INSTALLER_MAX_BYTES);
    } catch (error) {
      if (error instanceof ReleaseObjectTooLargeError) return "too_large";
      throw error;
    }
  }

  async #discard(channel: StandaloneReleaseChannel, version: string): Promise<void> {
    const { store } = this.#configured();
    for (const name of [
      standaloneInstallerFileName(version),
      standaloneManifestFileName(version),
    ]) {
      try {
        await store.remove(standaloneReleaseObjectKey(channel, version, name));
      } catch {
        // The release key may lack delete rights; the folder then stays listed as pending.
        this.#logger.warn(
          `Could not remove a refused standalone release file (${channel} ${version})`,
        );
      }
    }
  }

  async #lock(tx: Pick<Db, "execute">, channel: StandaloneReleaseChannel): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${LOCK_NAMESPACE}::integer, ${CHANNEL_LOCK[channel]}::integer)`,
    );
  }

  #auditBase(principal: PlatformPrincipal, channel: StandaloneReleaseChannel, version: string) {
    const actor: Actor = { userId: principal.userId, role: principal.role };
    return {
      actorPlatformUserId: actor.userId,
      actorRole: actor.role,
      tenantId: null,
      targetType: TARGET_TYPE,
      targetId: `${channel}/${version}`,
      requestId: null,
    };
  }

  #configured(): StandaloneReleasesRuntime {
    if (!this.runtime) throw standaloneReleaseError("standalone_releases_not_configured");
    return this.runtime;
  }

  /** Storage and network failures become one retryable answer; refusals pass through. */
  async #storage<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.#logger.error(
        `Standalone release storage failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
      throw standaloneReleaseError("standalone_releases_storage_unavailable");
    }
  }
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJson<T>(bytes: Buffer, schema: z.ZodType<T>): T | null {
  const text = decodeUtf8(bytes);
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
