import type { z } from "zod";

import {
  decodeUtf8Strict,
  parseJsonStrict,
  verifyCompactJws,
  type CompactJwsFailure,
  type TrustedKey,
} from "../signed-documents/compact-jws.js";
import {
  STANDALONE_LICENSE_MAX_BYTES,
  STANDALONE_LICENSE_TYP,
  STANDALONE_UPDATE_MANIFEST_MAX_BYTES,
  STANDALONE_UPDATE_TYP,
  standaloneLicensePayloadV1Schema,
  standaloneUpdateManifestV1Schema,
  type StandaloneLicensePayloadV1,
  type StandaloneUpdateManifestV1,
} from "./contracts.js";

/** The license keyset a build trusts: the issuer's origin and its keys by `kid`. */
export interface StandaloneLicenseKeyset {
  origin: string;
  keys: readonly TrustedKey[];
  retiredKids: readonly string[];
}
/** The release keyset: update manifests carry no issuer. */
export interface StandaloneUpdateKeyset {
  keys: readonly TrustedKey[];
  retiredKids: readonly string[];
}
export type StandaloneLicenseVerification =
  | { ok: true; kid: string; license: StandaloneLicensePayloadV1 }
  | { ok: false; reason: CompactJwsFailure };
export type StandaloneUpdateVerification =
  | { ok: true; kid: string; manifest: StandaloneUpdateManifestV1 }
  | { ok: false; reason: CompactJwsFailure };

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function readPayload<T>(bytes: Uint8Array, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(parseJsonStrict(decodeUtf8Strict(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Steps 1-4 of the host's check (spec §4.3): size, form, `kid`, signature,
 * then the payload strictly and its issuer against the keyset's origin. A
 * payload or issuer that does not fit is `malformed`. The binding (`hostId`,
 * INN, sequence) is the host's.
 */
export async function verifyStandaloneLicense(
  compact: string,
  keyset: StandaloneLicenseKeyset,
): Promise<StandaloneLicenseVerification> {
  if (utf8Length(compact) > STANDALONE_LICENSE_MAX_BYTES) return { ok: false, reason: "malformed" };
  const verified = await verifyCompactJws(compact, {
    typ: STANDALONE_LICENSE_TYP,
    keys: keyset.keys,
    retiredKids: keyset.retiredKids,
  });
  if (!verified.ok) return verified;
  const license = readPayload(verified.payload, standaloneLicensePayloadV1Schema);
  if (!license || license.issuer !== keyset.origin) return { ok: false, reason: "malformed" };
  return { ok: true, kid: verified.kid, license };
}

/** The same for an update manifest, signed by the release key. */
export async function verifyStandaloneUpdateManifest(
  compact: string,
  keyset: StandaloneUpdateKeyset,
): Promise<StandaloneUpdateVerification> {
  if (utf8Length(compact) > STANDALONE_UPDATE_MANIFEST_MAX_BYTES) {
    return { ok: false, reason: "malformed" };
  }
  const verified = await verifyCompactJws(compact, {
    typ: STANDALONE_UPDATE_TYP,
    keys: keyset.keys,
    retiredKids: keyset.retiredKids,
  });
  if (!verified.ok) return verified;
  const manifest = readPayload(verified.payload, standaloneUpdateManifestV1Schema);
  return manifest ? { ok: true, kid: verified.kid, manifest } : { ok: false, reason: "malformed" };
}
