import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  S3CatalogStore,
  type CatalogTransport,
} from "../src/modules/release-catalog/catalog-store";
const config = {
  endpoint: "https://s3.twcstorage.ru",
  region: "ru-1",
  bucket: "markiro-releases",
  accessKeyId: "fixture",
  secretAccessKey: "fixture",
};
function fake() {
  const versions = new Map<string, Buffer>();
  const calls: string[] = [];
  let serial = 0;
  const transport: CatalogTransport = {
    async get(input) {
      calls.push(`GET:${input.Key}:${input.VersionId}`);
      const body = versions.get(`${input.Key}:${input.VersionId}`);
      if (!body) throw new Error("missing");
      return {
        body: Readable.from([body]),
        versionId: input.VersionId,
        contentLength: body.length,
      };
    },
    async put(input) {
      calls.push(`PUT:${input.Key}`);
      const id = `v${++serial}`;
      if (!(input.Body instanceof Uint8Array)) throw new Error("fixture body");
      versions.set(`${input.Key}:${id}`, Buffer.from(input.Body));
      return { versionId: id };
    },
    async list() {
      return { versions: [], truncated: false };
    },
  };
  return { transport, calls, versions };
}
const signal = () => AbortSignal.timeout(1000);
async function bytes(body: Readable) {
  const result: Buffer[] = [];
  for await (const chunk of body) result.push(Buffer.from(chunk));
  return Buffer.concat(result);
}
describe("exact-version catalog storage", () => {
  it("passes an opaque VersionId through the actual SDK query without reading current head", async () => {
    const id = "opaque+/=?&%#",
      seen: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      seen.push(url.searchParams.get("versionId") ?? "CURRENT");
      res.setHeader("x-amz-version-id", id);
      res.setHeader("content-length", "1");
      res.end(url.searchParams.get("versionId") === id ? "A" : "B");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture address");
    const store = new S3CatalogStore({ ...config, endpoint: `http://127.0.0.1:${address.port}` });
    try {
      expect(
        await bytes(
          await store.readVersion(
            {
              bucket: config.bucket,
              key: "station/beta/releases/1.0.0-beta.1/app.exe",
              versionId: id,
            },
            signal(),
          ),
        ),
      ).toEqual(Buffer.from("A"));
      expect(seen).toEqual([id]);
    } finally {
      store.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("retains A after a provider accepts a repeated same-key PUT of B", async () => {
    const f = fake(),
      store = new S3CatalogStore(config, f.transport),
      key = "station/_uploads/fixture/app.exe";
    await f.transport.put({ Bucket: config.bucket, Key: key, Body: Buffer.from("A") }, signal());
    await f.transport.put({ Bucket: config.bucket, Key: key, Body: Buffer.from("B") }, signal());
    expect(
      await bytes(
        await store.readVersion({ bucket: config.bucket, key, versionId: "v1" }, signal()),
      ),
    ).toEqual(Buffer.from("A"));
    expect(f.calls.at(-1)).toBe(`GET:${key}:v1`);
  });
  it.each(["", "null", "NULL", "bad\nversion"])(
    "refuses invalid version %j before a request",
    async (versionId) => {
      const f = fake(),
        store = new S3CatalogStore(config, f.transport);
      await expect(
        store.readVersion({ bucket: config.bucket, key: "station/a", versionId }, signal()),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    },
  );
  it("refuses foreign bucket, escaped key and wrong returned version with no fallback", async () => {
    const f = fake(),
      store = new S3CatalogStore(config, f.transport);
    for (const target of [
      { bucket: "backup", key: "station/a", versionId: "v1" },
      { bucket: config.bucket, key: "station/../secret", versionId: "v1" },
      { bucket: config.bucket, key: "station/a?versionId=v2", versionId: "v1" },
    ])
      await expect(store.readVersion(target, signal())).rejects.toThrow();
    expect(f.calls).toEqual([]);
    f.transport.get = async () => ({
      body: Readable.from(["B"]),
      versionId: "v2",
      contentLength: 1,
    });
    await expect(
      store.readVersion({ bucket: config.bucket, key: "station/a", versionId: "v1" }, signal()),
    ).rejects.toThrow();
  });
  it("only writes a ledger operation and verifies the returned exact version's bytes", async () => {
    const f = fake(),
      store = new S3CatalogStore(config, f.transport),
      id = randomUUID(),
      body = Buffer.from('{"schema":1}');
    const result = await store.writeReceipt(id, body);
    expect(result).toEqual({ key: `_publication-ledger/${id}.json`, versionId: "v1" });
    expect(f.calls).toEqual([
      `PUT:_publication-ledger/${id}.json`,
      `GET:_publication-ledger/${id}.json:v1`,
    ]);
    expect(
      createHash("sha256")
        .update(f.versions.get(`${result.key}:v1`) ?? Buffer.alloc(0))
        .digest("hex"),
    ).toBe(createHash("sha256").update(body).digest("hex"));
    f.transport.get = async () => ({
      body: Readable.from(["wrong"]),
      versionId: "v2",
      contentLength: 5,
    });
    await expect(store.writeReceipt(randomUUID(), body)).rejects.toThrow();
  });
  it("requires explicit listing completeness and carries both markers and deletion evidence", async () => {
    const f = fake(),
      store = new S3CatalogStore(config, f.transport),
      key = `_publication-ledger/${randomUUID()}.json`;
    f.transport.list = async (input) => {
      expect(input.Prefix).toBe("_publication-ledger/");
      return {
        versions: [
          { key, versionId: "v1", deleted: false },
          { key, versionId: "v2", deleted: true },
        ],
        truncated: true,
        nextKeyMarker: key,
        nextVersionIdMarker: "v2",
      };
    };
    const page = await store.listReceiptVersions();
    expect(page.versions).toHaveLength(2);
    expect(page.nextCursor).toEqual({ key, versionId: "v2" });
    await expect(store.listReceiptVersions(page.nextCursor)).rejects.toThrow();
    f.transport.list = async () => ({ versions: [], truncated: undefined });
    await expect(store.listReceiptVersions()).rejects.toThrow();
  });
});
