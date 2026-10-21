import { z } from "zod";

import { platformTimestampSchema } from "./primitives.js";

/**
 * «Выпуски автонома» in the SaaS admin (spec 2026-10-20 §5). The owner signs a
 * release offline; the panel only uploads the two files into the public release
 * bucket, has the API verify them and moves the channel's `latest.json`. Nothing
 * here signs anything.
 */
export const STANDALONE_RELEASE_PRODUCT = "markiro-standalone";
export const STANDALONE_RELEASE_PREFIX = "standalone";

export const STANDALONE_RELEASE_ERROR_CODES = [
  "standalone_releases_not_configured",
  "standalone_releases_storage_unavailable",
  "standalone_release_version_exists",
  "standalone_release_version_not_newer",
  "standalone_release_files_missing",
  "standalone_release_installer_too_large",
  "standalone_release_manifest_malformed",
  "standalone_release_manifest_unknown_key",
  "standalone_release_manifest_bad_signature",
  "standalone_release_manifest_mismatch",
  "standalone_release_installer_size_mismatch",
  "standalone_release_installer_hash_mismatch",
  "standalone_release_immutable",
  "standalone_release_not_found",
  "standalone_release_integrity_failed",
] as const;
export type StandaloneReleaseErrorCode = (typeof STANDALONE_RELEASE_ERROR_CODES)[number];

export const standaloneReleaseChannelSchema = z.enum(["stable", "beta"]);
export type StandaloneReleaseChannel = z.infer<typeof standaloneReleaseChannelSchema>;
export const STANDALONE_RELEASE_CHANNELS = standaloneReleaseChannelSchema.options;

/** The manifest's own version grammar (`@markiro/domain`): x.y.z, no leading zeros. */
export const STANDALONE_RELEASE_VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
export const standaloneReleaseVersionSchema = z.string().regex(STANDALONE_RELEASE_VERSION_PATTERN);

/** Negative, zero or positive as `left` is older, equal to or newer than `right`. */
export function compareStandaloneReleaseVersions(left: string, right: string): number {
  const parts = (value: string) => {
    const match = STANDALONE_RELEASE_VERSION_PATTERN.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  };
  const [a, b] = [parts(left), parts(right)];
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}

export const standaloneInstallerFileName = (version: string) =>
  `${STANDALONE_RELEASE_PRODUCT}-${version}-windows-x86_64-setup.exe`;
export const standaloneManifestFileName = (version: string) =>
  `${STANDALONE_RELEASE_PRODUCT}-${version}.update.jws`;
/** The immutable folder of one version (spec §5.2 step 4). */
export const standaloneReleaseObjectKey = (
  channel: StandaloneReleaseChannel,
  version: string,
  name: string,
) => `${STANDALONE_RELEASE_PREFIX}/${channel}/${version}/${name}`;
/** The channel's mutable pointer (spec §5.3). */
export const standaloneLatestObjectKey = (channel: StandaloneReleaseChannel) =>
  `${STANDALONE_RELEASE_PREFIX}/${channel}/latest.json`;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const sizeSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const httpsUrlSchema = z.url({ protocol: /^https$/ }).max(2_048);
const noteSchema = z.string().min(1).max(200);

/** `standalone/<channel>/latest.json`, exactly as spec §5.3 shows it. Unsigned. */
export const standaloneLatestPointerSchema = z
  .object({
    v: z.literal(1),
    product: z.literal(STANDALONE_RELEASE_PRODUCT),
    channel: standaloneReleaseChannelSchema,
    version: standaloneReleaseVersionSchema,
    releasedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/),
    installer: z
      .object({ url: httpsUrlSchema, sha256: sha256Schema, sizeBytes: sizeSchema })
      .strict(),
    manifestUrl: httpsUrlSchema,
    notes: z.array(noteSchema).max(30),
  })
  .strict();
export type StandaloneLatestPointer = z.infer<typeof standaloneLatestPointerSchema>;

export const standaloneReleaseFileSchema = z
  .object({
    name: z.string().min(1).max(128),
    url: httpsUrlSchema,
    sha256: sha256Schema,
    sizeBytes: sizeSchema,
  })
  .strict();
export type StandaloneReleaseFile = z.infer<typeof standaloneReleaseFileSchema>;

/** A verified, registered version: the manifest's facts plus where its files are. */
export const standaloneReleaseSchema = z
  .object({
    channel: standaloneReleaseChannelSchema,
    version: standaloneReleaseVersionSchema,
    releasedAt: platformTimestampSchema,
    registeredAt: platformTimestampSchema,
    kid: z.string().min(1).max(128),
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    protocol: z.number().int().positive(),
    minProtocol: z.number().int().positive(),
    minUpgradeFrom: standaloneReleaseVersionSchema,
    notes: z.array(noteSchema).max(30),
    installer: standaloneReleaseFileSchema,
    manifest: standaloneReleaseFileSchema,
  })
  .strict();
export type StandaloneRelease = z.infer<typeof standaloneReleaseSchema>;

export const standaloneReleaseChannelViewSchema = z
  .object({
    channel: standaloneReleaseChannelSchema,
    /** The version `latest.json` points at, or `null` when the channel has none yet. */
    latest: standaloneReleaseVersionSchema.nullable(),
    /** `false` when a `latest.json` exists but is not one this API would write. */
    latestReadable: z.boolean(),
    /** Registered versions, newest first. */
    releases: z.array(standaloneReleaseSchema),
    /** Version folders with files but no registration (an unfinished upload). */
    pending: z.array(standaloneReleaseVersionSchema),
  })
  .strict();
export type StandaloneReleaseChannelView = z.infer<typeof standaloneReleaseChannelViewSchema>;

export const standaloneReleaseListSchema = z.discriminatedUnion("configured", [
  z.object({ configured: z.literal(false) }).strict(),
  z
    .object({
      configured: z.literal(true),
      publicOrigin: httpsUrlSchema,
      channels: z.array(standaloneReleaseChannelViewSchema),
    })
    .strict(),
]);
export type StandaloneReleaseList = z.infer<typeof standaloneReleaseListSchema>;

/** What the panel names; the API derives the object keys itself. */
export const standaloneReleaseTargetSchema = z
  .object({ channel: standaloneReleaseChannelSchema, version: standaloneReleaseVersionSchema })
  .strict();
export type StandaloneReleaseTarget = z.infer<typeof standaloneReleaseTargetSchema>;

export const standaloneReleaseUploadTargetSchema = z
  .object({
    name: z.string().min(1).max(128),
    uploadUrl: httpsUrlSchema.or(z.url({ protocol: /^http$/ }).max(2_048)),
    contentType: z.literal("application/octet-stream"),
  })
  .strict();
export const standaloneReleaseUploadSchema = z
  .object({
    channel: standaloneReleaseChannelSchema,
    version: standaloneReleaseVersionSchema,
    expiresAt: platformTimestampSchema,
    installer: standaloneReleaseUploadTargetSchema,
    manifest: standaloneReleaseUploadTargetSchema,
  })
  .strict();
export type StandaloneReleaseUpload = z.infer<typeof standaloneReleaseUploadSchema>;

export const standaloneReleaseRegistrationSchema = z
  .object({
    /** `unchanged` when the same bytes were already registered (a retried click). */
    outcome: z.enum(["registered", "unchanged"]),
    release: standaloneReleaseSchema,
  })
  .strict();
export type StandaloneReleaseRegistration = z.infer<typeof standaloneReleaseRegistrationSchema>;

export const standaloneReleaseChannelParamsSchema = z
  .object({ channel: standaloneReleaseChannelSchema })
  .strict();
export const standaloneReleaseSetLatestSchema = z
  .object({ version: standaloneReleaseVersionSchema })
  .strict();
export type StandaloneReleaseSetLatest = z.infer<typeof standaloneReleaseSetLatestSchema>;

const base = "/platform/standalone-releases";
export const platformStandaloneReleaseContracts = {
  list: { method: "GET", path: base, response: standaloneReleaseListSchema },
  upload: {
    method: "POST",
    path: `${base}/uploads`,
    body: standaloneReleaseTargetSchema,
    response: standaloneReleaseUploadSchema,
  },
  register: {
    method: "POST",
    path: `${base}/registrations`,
    body: standaloneReleaseTargetSchema,
    response: standaloneReleaseRegistrationSchema,
  },
  setLatest: {
    method: "PUT",
    path: `${base}/{channel}/latest`,
    params: standaloneReleaseChannelParamsSchema,
    body: standaloneReleaseSetLatestSchema,
    response: standaloneReleaseChannelViewSchema,
  },
} as const;
