import { z } from "zod";
import { standaloneReleaseVersionSchema } from "./standalone-releases.js";

/** Admission only. Signatures, provenance and bytes require server verification. */
export const releaseProductSchema = z.enum(["station", "handheld", "standalone", "signer"]);
export const releaseChannelSchema = z.enum(["beta", "stable"]);
const stableStation = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const betaStation = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;
function stationVersion(pattern: RegExp) {
  return z
    .string()
    .max(128)
    .refine((value) => {
      const match = pattern.exec(value);
      return match !== null && match.slice(1).every((part) => Number.isSafeInteger(Number(part)));
    });
}
const numericVersion = z
  .string()
  .max(128)
  .regex(/^\d+\.\d+\.\d+$/);
export const releaseIdentitySchema = z.union([
  z
    .object({
      product: z.literal("station"),
      channel: z.literal("stable"),
      version: stationVersion(stableStation),
    })
    .strict(),
  z
    .object({
      product: z.literal("station"),
      channel: z.literal("beta"),
      version: stationVersion(betaStation),
    })
    .strict(),
  z
    .object({
      product: z.literal("handheld"),
      channel: releaseChannelSchema,
      version: numericVersion,
    })
    .strict(),
  z
    .object({
      product: z.literal("standalone"),
      channel: releaseChannelSchema,
      version: standaloneReleaseVersionSchema,
    })
    .strict(),
  z
    .object({ product: z.literal("signer"), channel: z.literal("stable"), version: numericVersion })
    .strict(),
]);
export type ReleaseIdentity = z.infer<typeof releaseIdentitySchema>;
export type ReleaseProduct = z.infer<typeof releaseProductSchema>;
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>;

export const releaseFileNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/);
export const releaseSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const releaseContentTypeSchema = z.enum([
  "application/octet-stream",
  "application/zip",
  "application/json",
  "application/vnd.android.package-archive",
  "text/plain",
  "text/plain; charset=utf-8",
  "text/markdown",
]);
export const releaseFileSpecSchema = z
  .object({
    name: releaseFileNameSchema,
    sha256: releaseSha256Schema,
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 * 1024),
    contentType: releaseContentTypeSchema,
  })
  .strict();
export type ReleaseFileSpec = z.infer<typeof releaseFileSpecSchema>;

export const releaseVersionIdSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value.trim() === value &&
      value.length > 0 &&
      value.toLowerCase() !== "null" &&
      !/[\p{Cc}\p{Cs}]/u.test(value) &&
      new TextEncoder().encode(value).length <= 1024,
  );
export const releaseOperationIdSchema = z.uuid().refine((value) => value === value.toLowerCase());

const evidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("station"),
      manifestName: z.literal("latest.json"),
      evidenceName: z.literal("release-evidence.json"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("handheld"),
      manifestName: z.literal("manifest.json"),
      versionCode: z.number().int().positive().max(2147483647),
    })
    .strict(),
  z.object({ kind: z.literal("standalone"), manifestName: releaseFileNameSchema }).strict(),
]);
function distinctNames(files: readonly { name: string }[]) {
  return new Set(files.map((file) => file.name.toLowerCase())).size === files.length;
}
export const publicationRequestSchema = z
  .object({
    identity: releaseIdentitySchema,
    sourceSha: z.string().regex(/^[0-9a-f]{40}$/),
    files: z
      .array(releaseFileSpecSchema)
      .min(1)
      .max(16)
      .refine(distinctNames, "duplicate file names")
      .refine(
        (files) =>
          files.reduce((total, file) => total + file.sizeBytes, 0) <= 2 * 1024 * 1024 * 1024,
        "file set too large",
      ),
    evidence: evidenceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.identity.product !== value.evidence.kind)
      ctx.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "evidence does not belong to this product",
      });
    const names = new Set(value.files.map((file) => file.name));
    const required =
      value.evidence.kind === "station"
        ? [value.evidence.manifestName, value.evidence.evidenceName]
        : [value.evidence.manifestName];
    if (required.some((name) => !names.has(name)))
      ctx.addIssue({ code: "custom", path: ["files"], message: "evidence file absent" });
  });
export type PublicationRequest = z.infer<typeof publicationRequestSchema>;
export const publicationIntentRequestSchema = z
  .object({
    idempotencyKey: releaseOperationIdSchema,
    publication: publicationRequestSchema,
  })
  .strict();
export const publicationCommitRequestSchema = z
  .object({
    files: z
      .array(z.object({ name: releaseFileNameSchema, versionId: releaseVersionIdSchema }).strict())
      .min(1)
      .max(16)
      .refine(distinctNames, "duplicate file names"),
  })
  .strict();
export type PublicationCommitRequest = z.infer<typeof publicationCommitRequestSchema>;

export const catalogRevisionSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine((value) => /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n);
const channelIdentitySchema = z
  .object({ product: releaseProductSchema, channel: releaseChannelSchema })
  .strict()
  .refine((value) => value.product !== "signer" || value.channel === "stable");
export const channelSnapshotSchema = z
  .object({
    identity: channelIdentitySchema,
    revision: catalogRevisionSchema,
    publicationId: releaseOperationIdSchema.nullable(),
    readable: z.boolean(),
  })
  .strict();
export type ChannelSnapshot = z.infer<typeof channelSnapshotSchema>;
export const channelChangeRequestSchema = z
  .object({
    operationId: releaseOperationIdSchema,
    expectedRevision: catalogRevisionSchema,
    targetPublicationId: releaseOperationIdSchema,
    kind: z.enum(["forward", "rollback"]),
  })
  .strict();
export type ChannelChangeRequest = z.infer<typeof channelChangeRequestSchema>;

export const catalogIntentViewSchema = z
  .object({
    id: releaseOperationIdSchema,
    identity: releaseIdentitySchema,
    state: z.enum(["pending", "verified", "committed", "failed"]),
    expiresAt: z.iso.datetime(),
    files: z
      .array(releaseFileSpecSchema.extend({ key: z.string().max(512) }).strict())
      .min(1)
      .max(16)
      .refine(distinctNames),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.files.some((f) => f.key !== `${v.identity.product}/_uploads/${v.id}/${f.name}`))
      ctx.addIssue({ code: "custom", message: "invalid staged key" });
  });
export const catalogPublicationResultSchema = z
  .object({
    publicationId: releaseOperationIdSchema,
    identity: releaseIdentitySchema,
    files: z
      .array(
        releaseFileSpecSchema
          .extend({ publicPath: z.string().max(512), versionId: releaseVersionIdSchema })
          .strict(),
      )
      .min(1)
      .max(16)
      .refine(distinctNames),
  })
  .strict()
  .superRefine((v, ctx) => {
    const prefix =
      v.identity.product === "standalone"
        ? `/${v.identity.product}/${v.identity.channel}/${v.identity.version}/`
        : `/${v.identity.product}/${v.identity.channel}/releases/${v.identity.version}/`;
    if (v.files.some((f) => f.publicPath !== `${prefix}${f.name}`))
      ctx.addIssue({ code: "custom", message: "invalid publication path" });
  });
