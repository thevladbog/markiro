import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { StandaloneReleasesService } from "../src/modules/standalone-releases/standalone-releases.service";
import { CatalogFault } from "../src/modules/release-catalog/catalog-types";
import { admin, MemoryStore, ORIGIN } from "./support/standalone-releases";
const id = randomUUID(),
  key = randomUUID(),
  version = "1.1.0";
const input = {
  channel: "stable" as const,
  version,
  sourceSha: "a".repeat(40),
  idempotencyKey: key,
  installer: { sha256: "a".repeat(64), sizeBytes: 100 },
  manifest: { sha256: "b".repeat(64), sizeBytes: 200 },
};
function fixture() {
  const store = new MemoryStore();
  const names = [
    `markiro-standalone-${version}-windows-x86_64-setup.exe`,
    `markiro-standalone-${version}.update.jws`,
  ];
  const intent = {
    id,
    identity: { product: "standalone", channel: "stable", version },
    state: "pending",
    expiresAt: new Date(Date.now() + 900000).toISOString(),
    files: names.map((name, i) => ({
      name,
      ...(i === 0 ? input.installer : input.manifest),
      contentType: "application/octet-stream",
      key: `standalone/_uploads/${id}/${name}`,
    })),
  };
  const catalog = {
    createIntent: vi.fn(async () => intent),
    getIntent: vi.fn(async () => intent),
    commitIntent: vi.fn(),
    getChannel: vi.fn(),
    changeChannel: vi.fn(),
  };
  const repo = { publicationByIntent: vi.fn(async () => null) };
  const audit = { record: vi.fn(async () => {}) };
  const db = { transaction: async (f: (tx: unknown) => unknown) => f({}) };
  const service = new StandaloneReleasesService(
    db as never,
    audit as never,
    {
      config: {
        endpoint: "https://s3.twcstorage.ru",
        region: "ru-1",
        bucket: "markiro-releases",
        accessKeyId: "fixture",
        secretAccessKey: "fixture",
        publicOrigin: ORIGIN,
      },
      store,
    },
    catalog as never,
    repo as never,
    () => new Date(),
  );
  return { service, store, catalog, repo, intent, audit };
}
it("presigns only the reserved staged names with at most fifteen minutes and records actor", async () => {
  const f = fixture();
  const result = await f.service.createUpload(admin, input);
  expect(result.intentId).toBe(id);
  expect(f.store.presigned).toHaveLength(2);
  for (const put of f.store.presigned) {
    expect(put.key).toMatch(new RegExp(`^standalone/_uploads/${id}/`));
    expect(put.expires).toBeLessThanOrEqual(900);
  }
  expect(f.catalog.createIntent).toHaveBeenCalledWith(
    expect.anything(),
    key,
    expect.objectContaining({ sourceSha: input.sourceSha }),
  );
  expect(f.audit.record).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      actorPlatformUserId: admin.userId,
      action: "standalone_release.upload.authorize",
      outcome: "success",
    }),
  );
});
it("membership removal rejects commit before any staged HEAD or mutation", async () => {
  const f = fixture();
  f.catalog.getIntent.mockRejectedValue(new CatalogFault("forbidden"));
  await expect(f.service.register(admin, { intentId: id })).rejects.toMatchObject({ status: 403 });
  expect(f.catalog.commitIntent).not.toHaveBeenCalled();
  expect(f.store.removed).toEqual([]);
});
it("expired upload intent cannot issue new URLs", async () => {
  const f = fixture();
  f.intent.expiresAt = "2000-01-01T00:00:00.000Z";
  await expect(f.service.createUpload(admin, input)).rejects.toBeDefined();
  expect(f.store.presigned).toEqual([]);
});
it("missing staged bytes records denied registration without deleting evidence", async () => {
  const f = fixture();
  await expect(f.service.register(admin, { intentId: id })).rejects.toMatchObject({ status: 422 });
  expect(f.audit.record).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      actorPlatformUserId: admin.userId,
      action: "standalone_release.register",
      outcome: "denied",
      targetId: id,
    }),
  );
  expect(f.catalog.commitIntent).not.toHaveBeenCalled();
  expect(f.store.removed).toEqual([]);
});
