import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
  realpath,
  statfs,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { addAbortSignal } from "node:stream";
import { releaseSha256Schema, releaseVersionIdSchema } from "@markiro/platform-contracts";
import type { CatalogCacheConfig } from "./catalog-config";
import { CatalogFault } from "./catalog-types";
import type { CatalogStore } from "./catalog-store";
import type { PinnedObject } from "./catalog-types";
export interface CacheIO {
  freeBytes(path: string): Promise<number>;
  write(file: FileHandle, bytes: Uint8Array): Promise<void>;
  syncFile(file: FileHandle): Promise<void>;
}
export interface VerifiedFile {
  readonly size: number;
  readonly sha256: string;
  read(maxBytes: number): Promise<Buffer>;
  createReadStream(start?: number, end?: number): ReturnType<FileHandle["createReadStream"]>;
  close(): Promise<void>;
}
export function cacheBindingName(object: PinnedObject): string {
  return `${createHash("sha256")
    .update(
      JSON.stringify([
        object.publicPath,
        object.bucket,
        object.key,
        object.versionId,
        object.sha256,
        object.sizeBytes,
        object.contentType,
      ]),
    )
    .digest("hex")}.blob`;
}
function errorCode(e: unknown) {
  return e && typeof e === "object" && "code" in e ? e.code : undefined;
}
function privateFile(s: Stats) {
  if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
    throw new CatalogFault("unavailable");
}
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
/** One runtime owns this cache; all downloads and disk reservations share this coordinator. */
export class VerifiedCache {
  private readonly io: CacheIO;
  private readonly fills = new Map<string, Promise<void>>();
  private readonly budget = new Mutex();
  private readonly activeTemps = new Set<string>();
  private reserved = 0;
  private downloads = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(
    private readonly config: CatalogCacheConfig,
    private readonly store: Pick<CatalogStore, "readVersion">,
    io: Partial<CacheIO> = {},
  ) {
    if (
      ![
        config.cacheBytes,
        config.maxObjectBytes,
        config.diskReserveBytes,
        config.maxDownloads,
        config.timeoutMs,
      ].every((n) => Number.isSafeInteger(n) && n > 0) ||
      config.maxDownloads > 2 ||
      config.maxObjectBytes > config.cacheBytes
    )
      throw new CatalogFault("invalid_request");
    this.io = {
      freeBytes: async (path) => {
        const fs = await statfs(path);
        return fs.bavail * fs.bsize;
      },
      write: async (file, bytes) => {
        await file.writeFile(bytes);
      },
      syncFile: async (file) => {
        await file.sync();
      },
      ...io,
    };
  }
  private validate(object: PinnedObject) {
    if (
      object.bucket !== this.config.bucket ||
      !releaseSha256Schema.safeParse(object.sha256).success ||
      !releaseVersionIdSchema.safeParse(object.versionId).success ||
      !Number.isSafeInteger(object.sizeBytes) ||
      object.sizeBytes < 1 ||
      object.sizeBytes > this.config.maxObjectBytes
    )
      throw new CatalogFault("invalid_request");
  }
  private async directory() {
    const path = this.config.cacheDir,
      s = await lstat(path);
    if (
      !s.isDirectory() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== 0o700 ||
      (await realpath(path)) !== resolve(path)
    )
      throw new CatalogFault("unavailable");
  }
  private async syncDirectory() {
    const fd = await open(
      this.config.cacheDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
  }
  private async verified(object: PinnedObject): Promise<VerifiedFile> {
    const fd = await open(
      join(this.config.cacheDir, cacheBindingName(object)),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await fd.stat();
      privateFile(before);
      if (before.size !== object.sizeBytes) throw new CatalogFault("unavailable");
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(64 * 1024);
      let offset = 0;
      while (offset < object.sizeBytes) {
        const r = await fd.read(
          buffer,
          0,
          Math.min(buffer.length, object.sizeBytes - offset),
          offset,
        );
        if (!r.bytesRead) throw new CatalogFault("unavailable");
        hash.update(buffer.subarray(0, r.bytesRead));
        offset += r.bytesRead;
      }
      const after = await fd.stat();
      if (
        hash.digest("hex") !== object.sha256 ||
        after.size !== before.size ||
        after.ino !== before.ino ||
        after.dev !== before.dev ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs
      )
        throw new CatalogFault("unavailable");
      let closed = false;
      return {
        size: object.sizeBytes,
        sha256: object.sha256,
        async read(maxBytes) {
          if (closed || !Number.isSafeInteger(maxBytes) || maxBytes < object.sizeBytes)
            throw new CatalogFault("invalid_request");
          const result = Buffer.alloc(object.sizeBytes);
          let at = 0;
          while (at < result.length) {
            const r = await fd.read(result, at, result.length - at, at);
            if (!r.bytesRead) throw new CatalogFault("unavailable");
            at += r.bytesRead;
          }
          return result;
        },
        createReadStream(start = 0, end = object.sizeBytes - 1) {
          if (
            closed ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            end >= object.sizeBytes
          )
            throw new CatalogFault("invalid_request");
          return fd.createReadStream({ start, end, autoClose: false });
        },
        async close() {
          if (!closed) {
            closed = true;
            await fd.close();
          }
        },
      };
    } catch (error) {
      await fd.close();
      throw error;
    }
  }
  private async slot() {
    if (this.downloads >= this.config.maxDownloads)
      await new Promise<void>((r) => this.waiters.push(r));
    else this.downloads++;
    return () => {
      const next = this.waiters.shift();
      if (next) next();
      else this.downloads--;
    };
  }
  private async reserve(bytes: number, temp: string) {
    await this.budget.run(async () => {
      await this.directory();
      let total = this.reserved;
      const evict: { path: string; size: number; ino: number; time: number }[] = [];
      for (const name of await readdir(this.config.cacheDir)) {
        if (this.activeTemps.has(name)) continue;
        const path = join(this.config.cacheDir, name),
          s = await lstat(path);
        if (s.isSymbolicLink() || !s.isFile()) throw new CatalogFault("unavailable");
        total += s.size;
        if (/^[a-f0-9]{64}\.blob$/.test(name)) {
          privateFile(s);
          evict.push({ path, size: s.size, ino: s.ino, time: s.mtimeMs });
        }
      }
      for (const entry of evict.sort((a, b) => a.time - b.time)) {
        if (total + bytes <= this.config.cacheBytes) break;
        const current = await lstat(entry.path);
        privateFile(current);
        if (current.ino !== entry.ino) throw new CatalogFault("unavailable");
        await unlink(entry.path);
        total -= entry.size;
      }
      if (
        total + bytes > this.config.cacheBytes ||
        (await this.io.freeBytes(this.config.cacheDir)) <
          this.config.diskReserveBytes + bytes + this.reserved
      )
        throw new CatalogFault("unavailable");
      this.reserved += bytes;
      this.activeTemps.add(temp);
    });
  }
  private response(
    object: PinnedObject,
    signal: AbortSignal,
  ): ReturnType<CatalogStore["readVersion"]> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new CatalogFault("unavailable"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.store.readVersion(object, signal).then(
        (body) => {
          signal.removeEventListener("abort", abort);
          if (signal.aborted) {
            body.destroy();
            abort();
          } else resolve(body);
        },
        () => {
          signal.removeEventListener("abort", abort);
          reject(new CatalogFault("unavailable"));
        },
      );
    });
  }
  private async fill(object: PinnedObject) {
    const release = await this.slot(),
      temp = `${randomUUID()}.part`,
      path = join(this.config.cacheDir, temp);
    let reserved = false,
      created = false;
    try {
      await this.reserve(object.sizeBytes, temp);
      reserved = true;
      const fd = await open(path, "wx", 0o600);
      created = true;
      try {
        const signal = AbortSignal.timeout(this.config.timeoutMs),
          body = addAbortSignal(signal, await this.response(object, signal));
        const hash = createHash("sha256");
        let size = 0;
        try {
          for await (const chunk of body) {
            if (!(chunk instanceof Uint8Array)) throw new CatalogFault("unavailable");
            size += chunk.byteLength;
            if (size > object.sizeBytes) throw new CatalogFault("unavailable");
            await this.io.write(fd, chunk);
            hash.update(chunk);
          }
        } finally {
          body.destroy();
        }
        if (size !== object.sizeBytes || hash.digest("hex") !== object.sha256)
          throw new CatalogFault("unavailable");
        await this.io.syncFile(fd);
        await this.directory();
        try {
          await link(path, join(this.config.cacheDir, cacheBindingName(object)));
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
        }
      } finally {
        await fd.close();
      }
      await unlink(path);
      created = false;
      await this.syncDirectory();
    } finally {
      try {
        if (created) await unlink(path);
      } finally {
        if (reserved)
          await this.budget.run(() => {
            this.reserved -= object.sizeBytes;
            this.activeTemps.delete(temp);
          });
        release();
      }
    }
  }
  async acquire(object: PinnedObject): Promise<VerifiedFile> {
    this.validate(object);
    await this.directory();
    try {
      return await this.verified(object);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw new CatalogFault("unavailable");
    }
    const key = cacheBindingName(object);
    let pending = this.fills.get(key);
    if (!pending) {
      pending = this.fill(object);
      this.fills.set(key, pending);
      pending.finally(() => this.fills.delete(key)).catch(() => {});
    }
    try {
      await pending;
      await this.directory();
      return await this.verified(object);
    } catch {
      throw new CatalogFault("unavailable");
    }
  }
}
