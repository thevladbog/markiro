import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import type { StandaloneUpdateKeyset } from "@markiro/domain";
import { platformCapabilitiesForRole, type PlatformPrincipal } from "@markiro/platform-contracts";
import { signCompactJws } from "../../src/signing/compact-jws";
import {
  ReleaseObjectTooLargeError,
  type StandaloneReleaseStore,
} from "../../src/modules/standalone-releases/release-store";

/** An in-memory bucket with the store's semantics. */
export class MemoryStore implements StandaloneReleaseStore {
  readonly objects = new Map<
    string,
    { body: Buffer; contentType: string; cacheControl?: string }
  >();
  readonly presigned: { key: string; contentType: string; expires: number }[] = [];
  readonly removed: string[] = [];
  failReads = false;

  presignPut(key: string, contentType: string, expires: number) {
    this.presigned.push({ key, contentType, expires });
    return Promise.resolve(`https://storage.example.test/releases/${key}?X-Amz-Signature=fixture`);
  }
  head(key: string) {
    const object = this.objects.get(key);
    return Promise.resolve(object ? { size: object.body.byteLength } : null);
  }
  read(key: string, maxBytes: number) {
    if (this.failReads) return Promise.reject(new Error("connect ETIMEDOUT"));
    const object = this.objects.get(key);
    if (object && object.body.byteLength > maxBytes)
      return Promise.reject(new ReleaseObjectTooLargeError());
    return Promise.resolve(object ? Buffer.from(object.body) : null);
  }
  async digest(key: string, maxBytes: number) {
    const body = await this.read(key, maxBytes);
    return body
      ? { sha256: createHash("sha256").update(body).digest("hex"), size: body.byteLength }
      : null;
  }
  put(key: string, body: Buffer, contentType: string, cacheControl: string) {
    this.objects.set(key, { body: Buffer.from(body), contentType, cacheControl });
    return Promise.resolve();
  }
  listFolders(prefix: string) {
    const names = new Set<string>();
    for (const key of this.objects.keys())
      if (key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        if (rest.includes("/")) names.add(rest.slice(0, rest.indexOf("/")));
      }
    return Promise.resolve([...names]);
  }
  remove(key: string) {
    this.removed.push(key);
    this.objects.delete(key);
    return Promise.resolve();
  }
  text(key: string) {
    return this.objects.get(key)?.body.toString("utf8");
  }
}

export function keyPair(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKey,
    trusted: { kid, jwk: { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! } },
  };
}

export const release = keyPair("upd-test");
export const stranger = keyPair("upd-stranger");
export const KEYSET: StandaloneUpdateKeyset = { keys: [release.trusted], retiredKids: [] };
export const NOW = new Date("2026-10-21T12:00:00.000Z");
export const ORIGIN = "https://releases.markiro.app";
const UPDATE_TYP = "markiro-standalone-update+jws";

export const admin: PlatformPrincipal = {
  userId: "platform-admin-1",
  role: "platform_admin",
  capabilities: platformCapabilitiesForRole.platform_admin,
  twoFactorReady: true,
};

export const installerKey = (channel: string, version: string) =>
  `standalone/${channel}/${version}/markiro-standalone-${version}-windows-x86_64-setup.exe`;
export const manifestKey = (channel: string, version: string) =>
  `standalone/${channel}/${version}/markiro-standalone-${version}.update.jws`;
export const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function manifest(
  version: string,
  installer: Buffer,
  overrides: Record<string, unknown> = {},
  signer: { kid: string; privateKey: KeyObject } = release,
) {
  const payload = {
    v: 1,
    product: "markiro-standalone",
    version,
    channel: "stable",
    releasedAt: "2026-11-02T10:00:00Z",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    installer: {
      name: `markiro-standalone-${version}-windows-x86_64-setup.exe`,
      sha256: sha(installer),
      sizeBytes: installer.byteLength,
    },
    protocol: 2,
    minProtocol: 1,
    minUpgradeFrom: "0.1.0",
    notes: ["Печать паллет", "Исправления"],
    ...overrides,
  };
  return Buffer.from(`${signCompactJws(signer, UPDATE_TYP, payload)}\n`);
}
