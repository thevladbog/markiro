import { z } from "zod";

import { utf16BoundedString } from "../utf16-string.js";

/** `typ` of a license file's JWS header (spec 2026-10-13 §4.1). */
export const STANDALONE_LICENSE_TYP = "markiro-standalone-license+jws";
/** `typ` of an update manifest's JWS header (spec §10.1). */
export const STANDALONE_UPDATE_TYP = "markiro-standalone-update+jws";
/** A license file above this many UTF-8 bytes is refused unread (spec §4.3). */
export const STANDALONE_LICENSE_MAX_BYTES = 16 * 1024;
/** An update manifest above this many UTF-8 bytes is refused unread (spec §10.11.2). */
export const STANDALONE_UPDATE_MANIFEST_MAX_BYTES = 64 * 1024;
/**
 * The cloud's `ENTITLEMENT_QUOTA_KEYS` and `ENTITLEMENT_FEATURE_KEYS`, in their
 * order: the license is a signed export of the SaaS entitlements (spec §4), and
 * `@markiro/platform-contracts` asserts the lists stay equal.
 */
export const STANDALONE_QUOTA_KEYS = ["lines", "stations", "kiosks", "cabinetUsers"] as const;
export const STANDALONE_FEATURE_KEYS = [
  "labelEditor",
  "publicApi",
  "pallets",
  "chzIntegration",
  "inventory",
  "commerceMl",
  "handheld",
  "customLogo",
] as const;
export type StandaloneQuotaKey = (typeof STANDALONE_QUOTA_KEYS)[number];
export type StandaloneFeatureKey = (typeof STANDALONE_FEATURE_KEYS)[number];

// Lower-case canonical UUIDs (versions 1-8, the RFC variant): what the cloud
// and the host write, and what `markiro_proto::trust` accepts byte for byte.
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/**
 * An identifier the counterparty chooses (the license's `tenantId` and
 * `siteId`, owner decision 2026-10-13): 1-64 ASCII letters, digits and
 * `.`, `_`, `:`, `-`. Compared byte for byte, never lower-cased or trimmed, so
 * no whitespace, control character or Unicode look-alike gets in. A UUID and a
 * Better Auth id both fit. `markiro_proto::trust::is_opaque_id` is the twin.
 */
export const STANDALONE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
export const standaloneOpaqueIdSchema = z.string().regex(STANDALONE_OPAQUE_ID_PATTERN);
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/);
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const version = z.string().regex(VERSION);
const lowerHex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));

/**
 * No character that changes how the text around it shows: the C0 and C1
 * controls with DEL (U+0000-U+001F, U+007F-U+009F), the line and paragraph
 * separators (U+2028, U+2029) and the bidirectional embeddings, overrides and
 * isolates (U+202A-U+202E, U+2066-U+2069). `is_plain_text` in
 * `markiro_proto::trust` is the twin.
 */
function isPlainText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return false;
    }
  }
  return true;
}
/** 1 to `max` UTF-16 units of plain text, as `is_plain_text` in `markiro_proto::trust` counts. */
const plainText = (max: number) =>
  utf16BoundedString(1, max).refine(isPlainText, "Control characters are not allowed");

function versionParts(value: string): readonly [number, number, number] {
  const match = VERSION.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}
function compareVersions(left: string, right: string): number {
  const [a, b] = [versionParts(left), versionParts(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const quota = safeCount.nullable();
export const standaloneLicenseQuotasSchema = z
  .object({ lines: quota, stations: quota, kiosks: quota, cabinetUsers: quota })
  .strict();
export const standaloneLicenseFeaturesSchema = z
  .object({
    labelEditor: z.boolean(),
    publicApi: z.boolean(),
    pallets: z.boolean(),
    chzIntegration: z.boolean(),
    inventory: z.boolean(),
    commerceMl: z.boolean(),
    handheld: z.boolean(),
    // Custom branding (the organization's logo on printed forms and labels).
    // A file issued before the key existed has none: it reads as off.
    customLogo: z.boolean().default(false),
  })
  .strict();

/** The license file's payload (spec §4.2); read strictly, an unknown field is malformed. */
export const standaloneLicensePayloadV1Schema = z
  .object({
    version: z.literal(1),
    licenseId: uuid,
    sequence: positive,
    issuer: utf16BoundedString(1, 256),
    tenantId: standaloneOpaqueIdSchema,
    siteId: standaloneOpaqueIdSchema,
    hostId: uuid,
    customer: z
      .object({ name: plainText(300), inn: z.string().regex(/^(?:\d{10}|\d{12})$/) })
      .strict(),
    plan: z.enum(["demo", "subscription"]),
    planVersionId: uuid,
    entitlementRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),
    issuedAt: safeCount,
    validFrom: safeCount,
    validUntil: safeCount,
    graceDays: z.number().int().min(0).max(60),
    quotas: standaloneLicenseQuotasSchema,
    features: standaloneLicenseFeaturesSchema,
    replaces: uuid.nullable(),
  })
  .strict()
  .refine((license) => license.validFrom < license.validUntil, "validFrom must precede validUntil");

const innOrNone = z.string().regex(/^(?:\d{10}|\d{12})?$/);
/** The host's activation request (spec §6.3): unsigned, no secret in it. */
export const standaloneActivationRequestSchema = z
  .object({
    format: z.literal("markiro-activation-request-v1"),
    hostId: uuid,
    hostFingerprint: lowerHex(64),
    hostVersion: version,
    organization: z.object({ name: plainText(300), inn: innOrNone }).strict(),
    trial: z.object({ startedAt: instant, inn: innOrNone }).strict().nullable(),
    currentLicense: z.object({ licenseId: uuid, sequence: positive }).strict().nullable(),
    usage: z.object({ stations: safeCount, cabinetUsers: safeCount, lines: safeCount }).strict(),
    createdAt: instant,
  })
  .strict();

/** The signed update manifest (spec §10.2): the exact key set of a release. */
export const standaloneUpdateManifestV1Schema = z
  .object({
    v: z.literal(1),
    product: z.literal("markiro-standalone"),
    version,
    channel: z.enum(["beta", "stable"]),
    releasedAt: instant,
    sourceSha: lowerHex(40),
    installer: z
      .object({ name: z.string().min(1).max(128), sha256: lowerHex(64), sizeBytes: positive })
      .strict(),
    protocol: z.number().int().positive().max(4_294_967_295),
    minProtocol: z.number().int().positive().max(4_294_967_295),
    minUpgradeFrom: version,
    notes: z.array(plainText(200)).max(30),
  })
  .strict()
  .refine(
    (manifest) =>
      manifest.installer.name === `markiro-standalone-${manifest.version}-windows-x86_64-setup.exe`,
    "The installer is the release's own",
  )
  .refine((manifest) => manifest.minProtocol <= manifest.protocol, "minProtocol above protocol")
  .refine(
    (manifest) => compareVersions(manifest.minUpgradeFrom, manifest.version) <= 0,
    "minUpgradeFrom above version",
  );

export type StandaloneLicensePayloadV1 = z.infer<typeof standaloneLicensePayloadV1Schema>;
export type StandaloneActivationRequest = z.infer<typeof standaloneActivationRequestSchema>;
export type StandaloneUpdateManifestV1 = z.infer<typeof standaloneUpdateManifestV1Schema>;
