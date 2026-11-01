import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  assertUsHostedAdminRelease,
  usHostedAdminReleaseIdentity,
} from "./us-hosted-admin-release";

export type UsHostedAdminFileName =
  "database-password" | "database-ca" | "storage-access-key" | "storage-secret-key" | "storage-ca";
export type UsHostedAdminFileReader = Readonly<{
  read(name: UsHostedAdminFileName): Promise<Buffer>;
  assertUnchanged(): Promise<void>;
  dispose(): void;
}>;
const invalid = () => new Error("us_hosted_admin_file_invalid");
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/** Fixed unverified bytes only; this reader never issues administrative authority. */
export function createUsHostedAdminFileReader(release: unknown): UsHostedAdminFileReader {
  try {
    assertUsHostedAdminRelease(release);
    const { operation } = usHostedAdminReleaseIdentity(release);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (
      !Number.isSafeInteger(uid) ||
      uid === 0 ||
      uid === undefined ||
      uid < 0 ||
      !Number.isSafeInteger(gid) ||
      gid === undefined ||
      gid < 0 ||
      !["migrate", "seed", "provision"].includes(operation)
    )
      throw invalid();
    const parents = ["/run", "/run/secrets", "/run/secrets/us-demo"];
    const files: Record<
      UsHostedAdminFileName,
      { path: string; maximum: number; private: boolean; seed?: true }
    > = {
      "database-password": {
        path: `/run/secrets/us-demo/admin-${operation}-db-password`,
        maximum: 4096,
        private: true,
      },
      "database-ca": { path: "/run/secrets/us-demo/db-ca.pem", maximum: 65536, private: false },
      "storage-access-key": {
        path: "/run/secrets/us-demo/admin-seed-storage-access-key",
        maximum: 4096,
        private: true,
        seed: true,
      },
      "storage-secret-key": {
        path: "/run/secrets/us-demo/admin-seed-storage-secret-key",
        maximum: 4096,
        private: true,
        seed: true,
      },
      "storage-ca": {
        path: "/run/secrets/us-demo/storage-ca.pem",
        maximum: 65536,
        private: false,
        seed: true,
      },
    };
    const snapshots = new Map<string, BigIntStats>();
    const buffers = new Set<Buffer>();
    const consumed = new Set<UsHostedAdminFileName>();
    let disposed = false;
    let busy = false;
    const alive = () => {
      if (disposed) throw invalid();
      assertUsHostedAdminRelease(release);
      if (usHostedAdminReleaseIdentity(release).operation !== operation) throw invalid();
    };
    const directory = (stat: BigIntStats) => {
      if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) throw invalid();
    };
    const remember = (path: string, stat: BigIntStats) => {
      const previous = snapshots.get(path);
      if (previous && !same(previous, stat)) throw invalid();
      if (!previous) snapshots.set(path, stat);
    };
    return Object.freeze({
      async read(name: UsHostedAdminFileName): Promise<Buffer> {
        let bytes: Buffer | undefined;
        let entered = false;
        try {
          alive();
          if (busy || typeof name !== "string" || !Object.hasOwn(files, name) || consumed.has(name))
            throw invalid();
          const file = files[name];
          if (file.seed && operation !== "seed") throw invalid();
          consumed.add(name);
          busy = true;
          entered = true;
          const beforeParents: BigIntStats[] = [];
          for (const parent of parents) {
            const stat = await lstat(parent, { bigint: true });
            alive();
            directory(stat);
            const previous = snapshots.get(parent);
            if (previous && !same(previous, stat)) throw invalid();
            beforeParents.push(stat);
          }
          const handle = await open(
            file.path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            alive();
            const before = await handle.stat({ bigint: true });
            alive();
            const mode = before.mode & 0o7777n;
            if (
              !before.isFile() ||
              before.uid !== 0n ||
              !(
                (mode === 0o440n && before.gid === BigInt(gid)) ||
                (!file.private && mode === 0o444n)
              ) ||
              before.size <= 0n ||
              before.size > BigInt(file.maximum)
            )
              throw invalid();
            const expected = Number(before.size);
            bytes = Buffer.alloc(expected + 1);
            let length = 0;
            while (length < bytes.length) {
              const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
              alive();
              if (
                !Number.isSafeInteger(bytesRead) ||
                bytesRead < 0 ||
                bytesRead > bytes.length - length
              )
                throw invalid();
              if (bytesRead === 0) break;
              length += bytesRead;
            }
            const after = await handle.stat({ bigint: true });
            alive();
            const named = await lstat(file.path, { bigint: true });
            alive();
            if (length !== expected || !same(before, after) || !same(before, named))
              throw invalid();
            for (const [index, parent] of parents.entries()) {
              const stat = await lstat(parent, { bigint: true });
              alive();
              directory(stat);
              const previous = beforeParents[index];
              if (!previous || !same(previous, stat)) throw invalid();
              remember(parent, previous);
            }
            remember(file.path, before);
          } finally {
            await handle.close();
          }
          alive();
          if (!bytes) throw invalid();
          buffers.add(bytes);
          return bytes.subarray(0, bytes.length - 1);
        } catch {
          bytes?.fill(0);
          throw invalid();
        } finally {
          if (entered) busy = false;
        }
      },
      async assertUnchanged(): Promise<void> {
        let entered = false;
        try {
          alive();
          if (busy) throw invalid();
          busy = true;
          entered = true;
          for (const [path, before] of snapshots) {
            const after = await lstat(path, { bigint: true });
            alive();
            if (!same(before, after)) throw invalid();
          }
          alive();
        } catch {
          throw invalid();
        } finally {
          if (entered) busy = false;
        }
      },
      dispose(): void {
        disposed = true;
        for (const bytes of buffers) bytes.fill(0);
        buffers.clear();
        snapshots.clear();
      },
    });
  } catch {
    throw invalid();
  }
}
