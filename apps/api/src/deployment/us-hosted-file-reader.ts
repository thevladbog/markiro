import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { UsSyntheticHostedService } from "./us-synthetic-hosted-config";

export type UsHostedFileName =
  | "database-password"
  | "storage-access-key"
  | "storage-secret-key"
  | "database-ca"
  | "storage-ca"
  | "api-auth-secret"
  | "api-certificate"
  | "api-private-key";
export type UsHostedFileHandle = {
  stat(): Promise<BigIntStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};
export type UsHostedFileIO = {
  lstat(path: string): Promise<BigIntStats>;
  open(path: string, flags: number): Promise<UsHostedFileHandle>;
};
/** Trusted in-process test seams only; future executables supply no dependencies. */
export type UsHostedFileReaderDependencies = {
  root?: string;
  ownerUid?: number;
  runtimeUid?: number;
  runtimeGid?: number;
  io?: UsHostedFileIO;
};

const nativeIO: UsHostedFileIO = {
  lstat: (path) => lstat(path, { bigint: true }),
  async open(path, flags) {
    const handle = await open(path, flags);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
      close: () => handle.close(),
    };
  },
};
const invalid = () => new Error("us_hosted_file_invalid");
const identity = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
function same(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.gid === after.gid &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/** Low-level unverified bytes only. No runtime, material collection or release grant. */
export function createUsHostedFileReader(
  service: UsSyntheticHostedService,
  dependencies: UsHostedFileReaderDependencies = {},
): { read(name: UsHostedFileName): Promise<Buffer> } {
  try {
    const root = dependencies.root ?? "/run/secrets/us-demo";
    const ownerUid = dependencies.ownerUid ?? 0;
    const runtimeUid = dependencies.runtimeUid ?? process.getuid?.();
    const runtimeGid = dependencies.runtimeGid ?? process.getgid?.();
    if (
      (service !== "api" && service !== "worker") ||
      !identity(ownerUid) ||
      !identity(runtimeUid) ||
      runtimeUid === 0 ||
      !identity(runtimeGid) ||
      typeof root !== "string" ||
      resolve(root) !== root
    )
      throw invalid();
    const io = dependencies.io ?? nativeIO;
    const parents = dependencies.root === undefined ? ["/run", "/run/secrets", root] : [root];
    const files: Record<
      UsHostedFileName,
      { file: string; maximum: number; private: boolean; apiOnly?: true }
    > = {
      "database-password": { file: `${service}-db-password`, maximum: 4096, private: true },
      "storage-access-key": { file: `${service}-storage-access-key`, maximum: 4096, private: true },
      "storage-secret-key": { file: `${service}-storage-secret-key`, maximum: 4096, private: true },
      "database-ca": { file: "db-ca.pem", maximum: 65536, private: false },
      "storage-ca": { file: "storage-ca.pem", maximum: 65536, private: false },
      "api-auth-secret": { file: "api-auth-secret", maximum: 4096, private: true, apiOnly: true },
      "api-certificate": { file: "api-cert.pem", maximum: 65536, private: false, apiOnly: true },
      "api-private-key": { file: "api-key.pem", maximum: 16384, private: true, apiOnly: true },
    };
    const directory = (stat: BigIntStats) => {
      if (!stat.isDirectory() || stat.uid !== BigInt(ownerUid) || (stat.mode & 0o022n) !== 0n)
        throw invalid();
    };
    const reader = {
      async read(name: UsHostedFileName): Promise<Buffer> {
        let bytes: Buffer | undefined;
        try {
          if (typeof name !== "string" || !Object.hasOwn(files, name)) throw invalid();
          const file = files[name];
          if (file.apiOnly && service !== "api") throw invalid();
          const snapshots: BigIntStats[] = [];
          for (const parent of parents) {
            const stat = await io.lstat(parent);
            directory(stat);
            snapshots.push(stat);
          }
          const path = join(root, file.file);
          const handle = await io.open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          try {
            const before = await handle.stat();
            const mode = before.mode & 0o7777n;
            const groupRead = mode === 0o440n && before.gid === BigInt(runtimeGid);
            if (
              !before.isFile() ||
              before.uid !== BigInt(ownerUid) ||
              !(groupRead || (!file.private && mode === 0o444n)) ||
              before.size <= 0n ||
              before.size > BigInt(file.maximum)
            )
              throw invalid();
            const expected = Number(before.size);
            bytes = Buffer.alloc(expected + 1);
            let length = 0;
            while (length < bytes.length) {
              const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
              if (
                !Number.isSafeInteger(bytesRead) ||
                bytesRead < 0 ||
                bytesRead > bytes.length - length
              )
                throw invalid();
              if (bytesRead === 0) break;
              length += bytesRead;
            }
            if (
              length !== expected ||
              !same(before, await handle.stat()) ||
              !same(before, await io.lstat(path))
            )
              throw invalid();
            for (const [index, parent] of parents.entries()) {
              const after = await io.lstat(parent);
              directory(after);
              const snapshot = snapshots[index];
              if (!snapshot || !same(snapshot, after)) throw invalid();
            }
            return bytes.subarray(0, length);
          } finally {
            await handle.close();
          }
        } catch {
          bytes?.fill(0);
          throw invalid();
        }
      },
    };
    return Object.freeze(reader);
  } catch {
    throw invalid();
  }
}
