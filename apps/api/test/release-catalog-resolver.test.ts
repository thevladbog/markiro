import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogResolverController } from "../src/modules/release-catalog/catalog-resolver.controller";
import { CatalogResolver } from "../src/modules/release-catalog/catalog-resolver";
import { VerifiedCache } from "../src/modules/release-catalog/catalog-cache";
import type { CatalogReadSnapshot } from "../src/modules/release-catalog/catalog-read";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const roots: string[] = [],
  apps: INestApplication[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  for (const r of roots.splice(0)) await rm(r, { recursive: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "catalog-resolver-")));
  roots.push(root);
  const original = Buffer.from("MZ original release bytes"),
    replacement = Buffer.from("replacement");
  const path = "/station/stable/releases/2.2.0/markiro-station-2.2.0-windows-x86_64-setup.exe";
  const object = {
    publicPath: path,
    bucket: "markiro-releases",
    key: "station/_uploads/fixture/setup.exe",
    versionId: "opaque old version",
    sizeBytes: original.length,
    sha256: sha(original),
    contentType: "application/octet-stream" as const,
  };
  let snapshot: CatalogReadSnapshot | null = { kind: "object", object, mutable: false };
  let dbDown = false,
    s3Down = false,
    corrupt = false,
    reads = 0;
  const versions: string[] = [];
  const source = {
    async readSnapshot(requested: string) {
      reads++;
      if (dbDown) throw new Error("private database detail");
      return requested === path ||
        requested === "/station/stable/latest.json" ||
        requested === "/station/download"
        ? snapshot
        : null;
    },
  };
  const store = {
    async readVersion(target: { versionId: string }) {
      versions.push(target.versionId);
      if (s3Down) throw new Error("private credential detail");
      return Readable.from([
        !corrupt && target.versionId === object.versionId ? original : replacement,
      ]);
    },
  };
  let generation = 0;
  async function server(fresh = false) {
    const cacheDir = join(root, fresh ? `fresh-${++generation}` : "cache");
    await mkdir(cacheDir, { mode: 0o700, recursive: true });
    const cache = new VerifiedCache(
      {
        cacheDir,
        bucket: object.bucket,
        cacheBytes: 1024,
        maxObjectBytes: 1024,
        diskReserveBytes: 1,
        maxDownloads: 1,
        timeoutMs: 1000,
      },
      store,
    );
    const module = await Test.createTestingModule({
      controllers: [CatalogResolverController],
      providers: [{ provide: CatalogResolver, useValue: new CatalogResolver(source, cache) }],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    apps.push(app);
    await app.listen(0, "127.0.0.1");
    return `${await app.getUrl()}/internal/release-catalog`;
  }
  return {
    original,
    object,
    path,
    server,
    versions,
    reads: () => reads,
    setSnapshot: (s: CatalogReadSnapshot | null) => {
      snapshot = s;
    },
    dbDown: () => {
      dbDown = true;
    },
    s3Down: () => {
      s3Down = true;
    },
    corrupt: () => {
      corrupt = true;
    },
  };
}
describe("internal pinned release HTTP resolver", () => {
  it("serves original pinned bytes after overwrite, fresh process/cache and query injection", async () => {
    const f = await fixture();
    for (const base of [await f.server(), await f.server(true)]) {
      const r = await fetch(base + f.path + "?versionId=evil&X-Amz-Signature=ignored", {
        headers: { Authorization: "Bearer untrusted", Host: "evil.example" },
      });
      expect(r.status).toBe(200);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(f.original);
      expect(r.headers.get("etag")).toBe(`"sha256-${f.object.sha256}"`);
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect([...r.headers.keys()].some((k) => k.includes("version"))).toBe(false);
    }
    expect(f.versions).toEqual([f.object.versionId, f.object.versionId]);
    expect(f.reads()).toBe(2);
  });
  it("rechecks DB before warm cache, permits S3 outage only for verified cached bytes", async () => {
    const f = await fixture(),
      base = await f.server();
    expect((await fetch(base + f.path)).status).toBe(200);
    f.s3Down();
    expect((await fetch((await f.server()) + f.path)).status).toBe(200);
    f.dbDown();
    const r = await fetch(base + f.path);
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).not.toContain("private");
  });
  it("hash-verifies before HEAD, conditional 304 and partial responses", async () => {
    const f = await fixture(),
      base = await f.server();
    f.corrupt();
    for (const init of [
      { method: "HEAD" },
      { headers: { Range: "bytes=0-1" } },
      { headers: { "If-None-Match": `"sha256-${f.object.sha256}"` } },
    ])
      expect((await fetch(base + f.path, init)).status).toBe(503);
  });
  it("handles HEAD, exact single and suffix ranges, conditionals and rejects invalid ranges", async () => {
    const f = await fixture(),
      base = await f.server();
    const h = await fetch(base + f.path, { method: "HEAD" });
    expect(h.status).toBe(200);
    expect(h.headers.get("content-length")).toBe(String(f.original.length));
    expect(await h.text()).toBe("");
    for (const [range, start, end] of [
      ["bytes=0-1", 0, 1],
      ["bytes=-5", f.original.length - 5, f.original.length - 1],
      ["bytes=4-", 4, f.original.length - 1],
    ] as const) {
      const r = await fetch(base + f.path, { headers: { Range: range } });
      expect(r.status).toBe(206);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(f.original.subarray(start, end + 1));
      expect(r.headers.get("content-range")).toBe(`bytes ${start}-${end}/${f.original.length}`);
    }
    for (const range of [
      "bytes=0-1,3-4",
      "bytes=999-",
      "bytes=-0",
      "bytes=9-2",
      "other=1-2",
      "bytes=9007199254740993-",
    ]) {
      const r = await fetch(base + f.path, { headers: { Range: range } });
      expect(r.status).toBe(416);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
    expect(
      (
        await fetch(base + f.path, {
          headers: { "If-None-Match": `W/"sha256-${f.object.sha256}"` },
        })
      ).status,
    ).toBe(304);
    expect(
      (await fetch(base + f.path, { headers: { Range: "bytes=0-1", "If-Range": '"stale"' } }))
        .status,
    ).toBe(200);
  });
  it("serves snapshot pointer bytes with revalidation, mutable download and closed absence", async () => {
    const f = await fixture(),
      base = await f.server();
    const body = Buffer.from('{"version":"2.2.0"}');
    f.setSnapshot({ kind: "pointer", bytes: body, sha256: sha(body) });
    const p = await fetch(base + "/station/stable/latest.json");
    expect(p.status).toBe(200);
    expect(await p.text()).toBe(body.toString());
    expect(p.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    f.setSnapshot({ kind: "object", object: f.object, mutable: true });
    const d = await fetch(base + "/station/download");
    expect(d.status).toBe(200);
    expect(d.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(d.headers.get("content-disposition")).toContain("setup.exe");
    f.setSnapshot(null);
    const n = await fetch(base + f.path);
    expect(n.status).toBe(404);
    expect(n.headers.get("cache-control")).toBe("no-store");
  });
  it("refuses unsafe paths and methods without touching catalog", async () => {
    const f = await fixture(),
      base = await f.server();
    for (const path of [
      "/_publication-ledger/x",
      "/station/_uploads/x",
      "/station/stable/releases/2.2.0/a%2Fb.exe",
      "/station/stable/releases/2.2.0/a%252Fb.exe",
    ])
      expect((await fetch(base + path)).status).toBe(404);
    expect((await fetch(base + f.path, { method: "POST" })).status).toBe(404);
    expect(f.reads()).toBe(0);
  });
});
