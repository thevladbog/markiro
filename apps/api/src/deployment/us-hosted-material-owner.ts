import { createPrivateKey, X509Certificate } from "node:crypto";
import { inspect } from "node:util";
import { createUsHostedFileReader, type UsHostedFileName } from "./us-hosted-file-reader";
import {
  assertUsHostedRelease,
  usHostedReleaseIdentity,
  type VerifiedUsHostedRelease,
} from "./us-hosted-release-verifier";
import type { UsSyntheticHostedService } from "./us-synthetic-hosted-config";

const invalid = () => new Error("us_hosted_material_invalid");
const materialType: unique symbol = Symbol("us_hosted_material_owner");
export type UsHostedMaterialOwner = Readonly<{ [materialType]: true }>;
type MaterialRecord = {
  release: VerifiedUsHostedRelease;
  service: UsSyntheticHostedService;
  buffers: Map<UsHostedFileName, Buffer>;
  disposed: boolean;
};
const owners = new WeakMap<object, MaterialRecord>();
function redacted<T extends object>(value: T): Readonly<T> {
  for (const key of Reflect.ownKeys(value))
    Object.defineProperty(value, key, { enumerable: false });
  Object.defineProperties(value, {
    toJSON: { value: () => "[us_hosted_material]" },
    [inspect.custom]: { value: () => "[us_hosted_material]" },
  });
  return Object.freeze(value);
}
function record(
  owner: unknown,
  release: unknown,
  service: UsSyntheticHostedService,
): MaterialRecord {
  assertUsHostedRelease(release);
  if (!owner || typeof owner !== "object") throw invalid();
  const result = owners.get(owner);
  if (
    !result ||
    result.disposed ||
    result.release !== release ||
    result.service !== service ||
    usHostedReleaseIdentity(release).service !== service
  )
    throw invalid();
  return result;
}
export function assertUsHostedMaterial(
  owner: unknown,
  release: unknown,
  service: UsSyntheticHostedService,
): asserts owner is UsHostedMaterialOwner {
  try {
    record(owner, release, service);
  } catch {
    throw invalid();
  }
}
export function disposeUsHostedMaterial(owner: unknown): void {
  if (!owner || typeof owner !== "object") throw invalid();
  const result = owners.get(owner);
  if (!result) throw invalid();
  result.disposed = true;
  for (const buffer of result.buffers.values()) buffer.fill(0);
  result.buffers.clear();
}
function value(record: MaterialRecord, name: UsHostedFileName): Buffer {
  const buffer = record.buffers.get(name);
  if (!buffer || record.disposed) throw invalid();
  return buffer;
}
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function line(bytes: Buffer, minimum = 1): string {
  const decoded = decode(bytes);
  const text = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
  if (!text.length || [...text].length < minimum || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text))
    throw invalid();
  return text;
}
function certificates(bytes: Buffer): X509Certificate[] {
  const text = decode(bytes);
  const pattern =
    /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----/g;
  const certificates: X509Certificate[] = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    if (text.slice(offset, match.index).trim() || certificates.length >= 8) throw invalid();
    const certificate = new X509Certificate(match[0]);
    const start = Date.parse(certificate.validFrom);
    const end = Date.parse(certificate.validTo);
    const now = Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end < now)
      throw invalid();
    certificates.push(certificate);
    offset = match.index + match[0].length;
  }
  if (!certificates.length || text.slice(offset).trim()) throw invalid();
  return certificates;
}
function validate(buffers: Map<UsHostedFileName, Buffer>, service: UsSyntheticHostedService): void {
  const get = (name: UsHostedFileName) => {
    const result = buffers.get(name);
    if (!result) throw invalid();
    return result;
  };
  for (const name of ["database-password", "storage-access-key", "storage-secret-key"] as const)
    line(get(name));
  for (const name of ["database-ca", "storage-ca"] as const) {
    if (certificates(get(name)).some((certificate) => !certificate.ca)) throw invalid();
  }
  if (service === "worker") return;
  line(get("api-auth-secret"), 32);
  const chain = certificates(get("api-certificate"));
  const leaf = chain[0];
  if (
    !leaf ||
    leaf.ca ||
    chain.slice(1).some((certificate) => !certificate.ca) ||
    leaf.checkHost("api.us-demo.internal", {
      subject: "never",
      wildcards: false,
      partialWildcards: false,
      multiLabelWildcards: false,
      singleLabelSubdomains: false,
    }) !== "api.us-demo.internal"
  )
    throw invalid();
  const key = decode(get("api-private-key"));
  if (
    !/^\s*-----BEGIN (PRIVATE KEY|RSA PRIVATE KEY|EC PRIVATE KEY)-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END \1-----\s*$/.test(
      key,
    ) ||
    !leaf.checkPrivateKey(createPrivateKey(key))
  )
    throw invalid();
}

/** B2 identity is checked before even constructing the fixed secret reader. */
export async function collectUsHostedMaterial(release: unknown): Promise<UsHostedMaterialOwner> {
  const buffers = new Map<UsHostedFileName, Buffer>();
  try {
    assertUsHostedRelease(release);
    const { service } = usHostedReleaseIdentity(release);
    const reader = createUsHostedFileReader(service);
    const names: UsHostedFileName[] = [
      "database-password",
      "storage-access-key",
      "storage-secret-key",
      "database-ca",
      "storage-ca",
      ...(service === "api"
        ? (["api-auth-secret", "api-certificate", "api-private-key"] as const)
        : []),
    ];
    for (const name of names) {
      assertUsHostedRelease(release);
      buffers.set(name, await reader.read(name));
    }
    validate(buffers, service);
    assertUsHostedRelease(release);
    const handle: UsHostedMaterialOwner = redacted({ [materialType]: true });
    owners.set(handle, { release, service, buffers, disposed: false });
    return handle;
  } catch {
    for (const buffer of buffers.values()) buffer.fill(0);
    buffers.clear();
    throw invalid();
  }
}
function common(result: MaterialRecord) {
  return {
    database: redacted({
      password: line(value(result, "database-password")),
      ca: decode(value(result, "database-ca")),
    }),
    storage: redacted({
      accessKey: line(value(result, "storage-access-key")),
      secretKey: line(value(result, "storage-secret-key")),
      ca: decode(value(result, "storage-ca")),
    }),
  };
}
/** Named projections contain library-bound strings; copies cannot be promised erased. */
export function usHostedApiMaterial(owner: unknown, release: unknown) {
  try {
    const result = record(owner, release, "api");
    return redacted({
      ...common(result),
      authSecret: line(value(result, "api-auth-secret"), 32),
      tls: redacted({
        certificate: decode(value(result, "api-certificate")),
        privateKey: decode(value(result, "api-private-key")),
      }),
    });
  } catch {
    throw invalid();
  }
}
export function usHostedWorkerMaterial(owner: unknown, release: unknown) {
  try {
    return redacted(common(record(owner, release, "worker")));
  } catch {
    throw invalid();
  }
}
