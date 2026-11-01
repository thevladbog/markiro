import { X509Certificate } from "node:crypto";
import { inspect } from "node:util";
import {
  createUsHostedAdminFileReader,
  type UsHostedAdminFileName,
  type UsHostedAdminFileReader,
} from "./us-hosted-admin-file-reader";
import {
  assertUsHostedAdminRelease,
  usHostedAdminReleaseIdentity,
  type VerifiedUsHostedAdminRelease,
} from "./us-hosted-admin-release";
import type { UsHostedAdminOperation } from "./us-hosted-admin-config";

const invalid = () => new Error("us_hosted_admin_material_invalid");
const brand: unique symbol = Symbol("us_hosted_admin_material");
export type UsHostedAdminMaterialOwner = Readonly<{ [brand]: true }>;
type MaterialRecord = {
  release: VerifiedUsHostedAdminRelease;
  operation: UsHostedAdminOperation;
  buffers: Map<UsHostedAdminFileName, Buffer>;
  disposed: boolean;
};
const owners = new WeakMap<object, MaterialRecord>();
function redacted<T extends object>(value: T): Readonly<T> {
  for (const key of Reflect.ownKeys(value))
    Object.defineProperty(value, key, { enumerable: false });
  Object.defineProperties(value, {
    toJSON: { value: () => "[us_hosted_admin_material]" },
    [inspect.custom]: { value: () => "[us_hosted_admin_material]" },
  });
  return Object.freeze(value);
}
function record(owner: unknown, release: unknown): MaterialRecord {
  assertUsHostedAdminRelease(release);
  if (!owner || typeof owner !== "object") throw invalid();
  const result = owners.get(owner);
  if (
    !result ||
    result.disposed ||
    result.release !== release ||
    result.operation !== usHostedAdminReleaseIdentity(release).operation
  )
    throw invalid();
  return result;
}
function secret(bytes: Buffer): string {
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
  if (!value.length || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw invalid();
  return value;
}
function ca(bytes: Buffer): string {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const pattern =
    /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----/g;
  let offset = 0,
    count = 0;
  for (const match of value.matchAll(pattern)) {
    if (value.slice(offset, match.index).trim() || ++count > 8) throw invalid();
    const cert = new X509Certificate(match[0]);
    const start = Date.parse(cert.validFrom),
      end = Date.parse(cert.validTo),
      now = Date.now();
    if (!cert.ca || !Number.isFinite(start) || !Number.isFinite(end) || start > now || end < now)
      throw invalid();
    offset = match.index + match[0].length;
  }
  if (!count || value.slice(offset).trim()) throw invalid();
  return value;
}
function bytes(result: MaterialRecord, name: UsHostedAdminFileName): Buffer {
  const value = result.buffers.get(name);
  if (!value || result.disposed) throw invalid();
  return value;
}
function wipe(buffers: Map<UsHostedAdminFileName, Buffer>): void {
  for (const buffer of buffers.values()) buffer.fill(0);
  buffers.clear();
}
export function assertUsHostedAdminMaterial(
  owner: unknown,
  release: unknown,
): asserts owner is UsHostedAdminMaterialOwner {
  try {
    record(owner, release);
  } catch {
    throw invalid();
  }
}
export function disposeUsHostedAdminMaterial(owner: unknown): void {
  if (!owner || typeof owner !== "object") throw invalid();
  const result = owners.get(owner);
  if (!result) throw invalid();
  result.disposed = true;
  wipe(result.buffers);
}
/** Private material issuance; parsing and unverified reader bytes alone grant no authority. */
export async function collectUsHostedAdminMaterial(
  release: unknown,
): Promise<UsHostedAdminMaterialOwner> {
  const buffers = new Map<UsHostedAdminFileName, Buffer>();
  let reader: UsHostedAdminFileReader | undefined;
  try {
    assertUsHostedAdminRelease(release);
    const { operation } = usHostedAdminReleaseIdentity(release);
    reader = createUsHostedAdminFileReader(release);
    const names: UsHostedAdminFileName[] = [
      "database-password",
      "database-ca",
      ...(operation === "seed"
        ? (["storage-access-key", "storage-secret-key", "storage-ca"] as const)
        : []),
    ];
    const acquired = new Map<UsHostedAdminFileName, Buffer>();
    for (const name of names) {
      assertUsHostedAdminRelease(release);
      const value = await reader.read(name);
      assertUsHostedAdminRelease(release);
      if (name.endsWith("-ca")) ca(value);
      else secret(value);
      acquired.set(name, value);
    }
    await reader.assertUnchanged();
    for (const [name, value] of acquired) buffers.set(name, Buffer.from(value));
    assertUsHostedAdminRelease(release);
    if (usHostedAdminReleaseIdentity(release).operation !== operation) throw invalid();
    const owner: UsHostedAdminMaterialOwner = redacted({ [brand]: true });
    owners.set(owner, { release, operation, buffers, disposed: false });
    return owner;
  } catch {
    wipe(buffers);
    throw invalid();
  } finally {
    reader?.dispose();
  }
}
/** Library-bound strings are redacted but cannot be promised erased after projection. */
export function usHostedAdminDatabaseMaterial(owner: unknown, release: unknown) {
  try {
    const result = record(owner, release);
    return redacted({
      password: secret(bytes(result, "database-password")),
      ca: ca(bytes(result, "database-ca")),
    });
  } catch {
    throw invalid();
  }
}
export function usHostedAdminSeedStorageMaterial(owner: unknown, release: unknown) {
  try {
    const result = record(owner, release);
    if (result.operation !== "seed") throw invalid();
    return redacted({
      accessKey: secret(bytes(result, "storage-access-key")),
      secretKey: secret(bytes(result, "storage-secret-key")),
      ca: ca(bytes(result, "storage-ca")),
    });
  } catch {
    throw invalid();
  }
}
