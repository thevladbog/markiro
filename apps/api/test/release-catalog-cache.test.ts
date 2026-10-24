import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  VerifiedCache,
  cacheBindingName,
  type CacheIO,
} from "../src/modules/release-catalog/catalog-cache";
import type { PinnedObject } from "../src/modules/release-catalog/catalog-types";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function binding(body: Buffer, versionId = "v1"): PinnedObject {
  return {
    publicPath: "/standalone/stable/1.0.0/file.exe",
    bucket: "markiro-releases",
    key: "standalone/_uploads/fixture/file.exe",
    versionId,
    sha256: createHash("sha256").update(body).digest("hex"),
    sizeBytes: body.length,
    contentType: "application/octet-stream",
  };
}
async function fixture(body = Buffer.from("MZ original"), overrides: Partial<CacheIO> = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "catalog-cache-"));
  roots.push(root);
  await chmod(root, 0o700);
  const config = {
    cacheDir: root,
    bucket: "markiro-releases",
    cacheBytes: 128,
    maxObjectBytes: 64,
    diskReserveBytes: 1,
    maxDownloads: 2,
    timeoutMs: 200,
  };
  let calls = 0;
  const store = {
    async readVersion() {
      calls++;
      return Readable.from([body]);
    },
  };
  const cache = new VerifiedCache(config, store, overrides);
  return { root, config, store, cache, object: binding(body), calls: () => calls };
}
describe("verified bounded release cache", () => {
  it("returns only verified bytes, revalidates after restart and works during S3 outage", async () => {
    const f = await fixture();
    const file = await f.cache.acquire(f.object);
    expect(await file.read(64)).toEqual(Buffer.from("MZ original"));
    await file.close();
    f.store.readVersion = async () => {
      throw new Error("offline");
    };
    const fresh = new VerifiedCache(f.config, f.store);
    const hit = await fresh.acquire(f.object);
    expect(await hit.read(64)).toEqual(Buffer.from("MZ original"));
    await hit.close();
    await writeFile(join(f.root, cacheBindingName(f.object)), "corruption", { mode: 0o600 });
    await expect(new VerifiedCache(f.config, f.store).acquire(f.object)).rejects.toThrow();
    expect(await readFile(join(f.root, cacheBindingName(f.object)), "utf8")).toBe("corruption");
  });
  it.each([Buffer.from("changed"), Buffer.from("MZ ori"), Buffer.alloc(65)])(
    "rejects incorrect hash, truncated or oversized bytes without final entry",
    async (body) => {
      const f = await fixture();
      f.store.readVersion = async () => Readable.from([body]);
      await expect(f.cache.acquire(f.object)).rejects.toThrow();
      expect(await readdir(f.root)).toEqual([]);
    },
  );
  it("refuses a missing version before touching storage", async () => {
    const f = await fixture();
    await expect(f.cache.acquire({ ...f.object, versionId: "null" })).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });
  it("refuses symlink cache roots, entries and public directory permissions", async () => {
    const f = await fixture(),
      outside = join(f.root, "outside");
    await writeFile(outside, "keep", { mode: 0o600 });
    const name = join(f.root, cacheBindingName(f.object));
    await symlink(outside, name);
    await expect(f.cache.acquire(f.object)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("keep");
    await chmod(f.root, 0o755);
    await expect(f.cache.acquire(f.object)).rejects.toThrow();
    await chmod(f.root, 0o700);
    const alias = `${f.root}-alias`;
    roots.push(alias);
    await symlink(f.root, alias);
    await expect(
      new VerifiedCache({ ...f.config, cacheDir: alias }, f.store).acquire(f.object),
    ).rejects.toThrow();
  });
  it("reserves free space before download and removes only its temporary file on ENOSPC", async () => {
    const f = await fixture(undefined, { freeBytes: async () => 0 });
    await expect(f.cache.acquire(f.object)).rejects.toThrow();
    expect(f.calls()).toBe(0);
    const g = await fixture(undefined, {
      write: async () => {
        throw Object.assign(new Error("full"), { code: "ENOSPC" });
      },
    });
    const evidence = join(g.root, "preserved.part");
    await writeFile(evidence, "old", { mode: 0o600 });
    await expect(g.cache.acquire(g.object)).rejects.toThrow();
    expect(await readdir(g.root)).toEqual(["preserved.part"]);
  });
  it("does not publish a final entry after fsync failure", async () => {
    const f = await fixture(undefined, {
      syncFile: async () => {
        throw new Error("interrupted fsync");
      },
    });
    await expect(f.cache.acquire(f.object)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  });
  it("converges concurrent fills and bounds simultaneous downloads", async () => {
    const f = await fixture();
    let active = 0,
      peak = 0;
    f.store.readVersion = async () =>
      Readable.from(
        (async function* () {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 10));
          yield Buffer.from("MZ original");
          active--;
        })(),
      );
    const files = await Promise.all(
      [f.object, f.object, { ...f.object, versionId: "v2" }, { ...f.object, versionId: "v3" }].map(
        (o) => f.cache.acquire(o),
      ),
    );
    expect(peak).toBeLessThanOrEqual(2);
    for (const file of files) {
      expect(await file.read(64)).toEqual(Buffer.from("MZ original"));
      await file.close();
    }
    expect((await readdir(f.root)).filter((n) => n.endsWith(".blob"))).toHaveLength(3);
  });
  it("keeps an already held descriptor usable across eviction", async () => {
    const f = await fixture(Buffer.alloc(40, 65));
    const cache = new VerifiedCache({ ...f.config, cacheBytes: 64 }, f.store);
    const first = await cache.acquire(f.object);
    const next = await cache.acquire({ ...f.object, versionId: "v2" });
    expect(await first.read(64)).toEqual(Buffer.alloc(40, 65));
    await first.close();
    await next.close();
    expect((await readdir(f.root)).filter((n) => n.endsWith(".blob"))).toHaveLength(1);
  });
  it("aborts a stalled response and retains no partial success", async () => {
    const f = await fixture();
    f.store.readVersion = async () => new Readable({ read() {} });
    await expect(f.cache.acquire(f.object)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  });
  it("bounds a storage request that never returns a response", async () => {
    const f = await fixture();
    f.store.readVersion = async () => new Promise<Readable>(() => {});
    await expect(f.cache.acquire(f.object)).rejects.toThrow();
    expect(await readdir(f.root)).toEqual([]);
  }, 700);
  it("rejects overly permissive existing cache entries", async () => {
    const f = await fixture();
    const path = join(f.root, cacheBindingName(f.object));
    const file = await open(path, "wx", 0o644);
    await file.writeFile("MZ original");
    await file.close();
    await expect(f.cache.acquire(f.object)).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });
});
