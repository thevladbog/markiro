import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { CatalogStore } from "../../src/modules/release-catalog/catalog-store";
export function publicationOperation() {
  const id = randomUUID();
  return {
    schema: 1 as const,
    id,
    kind: "publication" as const,
    epoch: randomUUID(),
    identity: { product: "standalone" as const, channel: "stable" as const, version: "1.0.0" },
    requestDigest: "a".repeat(64),
    sourceSha: "b".repeat(40),
    files: [
      {
        publicPath: "/standalone/stable/1.0.0/app.exe",
        bucket: "markiro-releases",
        key: `standalone/_uploads/${id}/app.exe`,
        versionId: "original",
        sha256: "c".repeat(64),
        sizeBytes: 20,
        contentType: "application/octet-stream" as const,
      },
    ],
  };
}
export function fakeLedgerStore() {
  const versions = new Map<
    string,
    { key: string; versionId: string; bytes: Buffer; deleted: boolean }
  >();
  let puts = 0;
  const store: CatalogStore = {
    async readVersion(target) {
      const r = versions.get(`${target.key}:${target.versionId}`);
      if (!r || r.deleted) throw new Error("missing");
      return Readable.from([r.bytes]);
    },
    async writeReceipt(id, bytes) {
      puts++;
      const key = `_publication-ledger/${id}.json`,
        versionId = `v${puts}`;
      versions.set(`${key}:${versionId}`, {
        key,
        versionId,
        bytes: Buffer.from(bytes),
        deleted: false,
      });
      return { key, versionId };
    },
    async listReceiptVersions() {
      return {
        versions: [...versions.values()].map(({ key, versionId, deleted }) => ({
          key,
          versionId,
          deleted,
        })),
        nextCursor: undefined,
      };
    },
  };
  return { store, versions, puts: () => puts };
}
export function digest(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
