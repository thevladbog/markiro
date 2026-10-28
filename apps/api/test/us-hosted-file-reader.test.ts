import { execFileSync } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUsHostedFileReader,
  type UsHostedFileIO,
  type UsHostedFileReaderDependencies,
} from "../src/deployment/us-hosted-file-reader";

describe("hosted fixed-file admission", () => {
  let root: string;
  let dependencies: UsHostedFileReaderDependencies;
  let opened: number;
  let closed: number;
  let calls: number;
  let lastFlags: number;
  let lastBuffer: Buffer | undefined;
  let afterOpen: (() => Promise<void>) | undefined;
  let afterRead: (() => Promise<void>) | undefined;
  let changeStat: ((value: BigIntStats) => BigIntStats) | undefined;
  let failRead: boolean;
  let failClose: boolean;
  const privateName = "api-db-password";
  const bytes = Buffer.from("dummy-only-not-a-live-secret");
  const io: UsHostedFileIO = {
    async lstat(path) {
      calls++;
      return lstat(path, { bigint: true });
    },
    async open(path, flags) {
      calls++;
      lastFlags = flags;
      const handle = await open(path, flags);
      opened++;
      try {
        await afterOpen?.();
      } catch (error) {
        await handle.close();
        closed++;
        throw error;
      }
      return {
        async stat() {
          const stat = await handle.stat({ bigint: true });
          return changeStat ? changeStat(stat) : stat;
        },
        async read(buffer, offset, length, position) {
          lastBuffer = buffer;
          if (failRead) throw new Error("synthetic-secret-canary");
          const result = await handle.read(buffer, offset, length, position);
          const mutation = afterRead;
          afterRead = undefined;
          await mutation?.();
          return result;
        },
        async close() {
          await handle.close();
          closed++;
          if (failClose) throw new Error("synthetic-secret-canary");
        },
      };
    },
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "us-hosted-file-"));
    await chmod(root, 0o755);
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined) throw new Error("posix_test_identity_required");
    dependencies = { root, ownerUid: uid, runtimeUid: uid || 1, runtimeGid: gid, io };
    opened = closed = calls = lastFlags = 0;
    lastBuffer = undefined;
    afterOpen = afterRead = changeStat = undefined;
    failRead = failClose = false;
    await writeFile(join(root, privateName), bytes, { mode: 0o440 });
  });
  afterEach(async () => {
    expect(closed).toBe(opened);
    await rm(root, { recursive: true, force: true });
  });

  async function invalid(result: Promise<unknown>) {
    const error: unknown = await result.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", "us_hosted_file_invalid");
    expect(error).not.toHaveProperty("cause");
  }

  it("reads exact bounded bytes and closes a nonblocking nofollow descriptor", async () => {
    const reader = createUsHostedFileReader("api", dependencies);
    expect(calls).toBe(0);
    const result = await reader.read("database-password");
    expect(result).toEqual(bytes);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
    expect(lastFlags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(lastFlags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    result.fill(0);
    expect(await createUsHostedFileReader("api", dependencies).read("database-password")).toEqual(
      bytes,
    );
  });
  it("allows public certificate permissions without exposing another service", async () => {
    await writeFile(join(root, "db-ca.pem"), bytes, { mode: 0o444 });
    expect(await createUsHostedFileReader("worker", dependencies).read("database-ca")).toEqual(
      bytes,
    );
    const worker = createUsHostedFileReader("worker", dependencies);
    const before = calls;
    await invalid(worker.read("api-auth-secret"));
    await invalid(worker.read("api-certificate"));
    await invalid(worker.read("api-private-key"));
    await invalid(Reflect.apply(worker.read, worker, ["../api-db-password"]));
    await invalid(Reflect.apply(worker.read, worker, ["__proto__"]));
    expect(calls).toBe(before);
  });
  it.each([
    ["api", "database-password", "api-db-password", 4096, true],
    ["api", "storage-access-key", "api-storage-access-key", 4096, true],
    ["api", "storage-secret-key", "api-storage-secret-key", 4096, true],
    ["api", "database-ca", "db-ca.pem", 65536, false],
    ["api", "storage-ca", "storage-ca.pem", 65536, false],
    ["api", "api-auth-secret", "api-auth-secret", 4096, true],
    ["api", "api-certificate", "api-cert.pem", 65536, false],
    ["api", "api-private-key", "api-key.pem", 16384, true],
    ["worker", "database-password", "worker-db-password", 4096, true],
    ["worker", "storage-access-key", "worker-storage-access-key", 4096, true],
    ["worker", "storage-secret-key", "worker-storage-secret-key", 4096, true],
    ["worker", "database-ca", "db-ca.pem", 65536, false],
    ["worker", "storage-ca", "storage-ca.pem", 65536, false],
  ] as const)(
    "binds %s/%s to its exact file and cap",
    async (service, name, file, cap, privateFile) => {
      const path = join(root, file);
      if (file === privateName) await rm(path);
      const value = Buffer.alloc(cap, 0x73);
      await writeFile(path, value, { mode: privateFile ? 0o440 : 0o444 });
      const reader = createUsHostedFileReader(service, dependencies);
      expect(await reader.read(name)).toEqual(value);
      await chmod(path, 0o640);
      await writeFile(path, Buffer.alloc(cap + 1, 0x73));
      await chmod(path, privateFile ? 0o440 : 0o444);
      await invalid(reader.read(name));
    },
  );
  it("rejects invalid service, root runtime and missing runtime identities without I/O", () => {
    for (const value of ["invalid", null, undefined])
      expect(() =>
        Reflect.apply(createUsHostedFileReader, undefined, [value, dependencies]),
      ).toThrow("us_hosted_file_invalid");
    expect(() => createUsHostedFileReader("api", { ...dependencies, runtimeUid: 0 })).toThrow(
      "us_hosted_file_invalid",
    );
    expect(() => createUsHostedFileReader("api", { ...dependencies, runtimeGid: -1 })).toThrow(
      "us_hosted_file_invalid",
    );
    expect(calls).toBe(0);
  });
  it.each([0o400, 0o600, 0o640, 0o444, 0o441, 0o1440])("refuses private mode %i", async (mode) => {
    await chmod(join(root, privateName), mode);
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
  });
  it.each([0o777, 0o775, 0o757])("refuses writable root mode %i before open", async (mode) => {
    await chmod(root, mode);
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
    expect(opened).toBe(0);
  });
  it("refuses owner or group mismatches", async () => {
    const uid = dependencies.ownerUid;
    const gid = dependencies.runtimeGid;
    if (uid === undefined || gid === undefined) throw new Error("test_identity_missing");
    await invalid(
      createUsHostedFileReader("api", { ...dependencies, ownerUid: uid + 1 }).read(
        "database-password",
      ),
    );
    await invalid(
      createUsHostedFileReader("api", { ...dependencies, runtimeGid: gid + 1 }).read(
        "database-password",
      ),
    );
    changeStat = (stat) => Object.assign(stat, { uid: BigInt(uid + 1) });
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
  });
  it("refuses missing, symlinked and directory files and a symlink root", async () => {
    const reader = createUsHostedFileReader("api", dependencies);
    await invalid(reader.read("api-private-key"));
    await symlink(join(root, privateName), join(root, "api-key.pem"));
    await invalid(reader.read("api-private-key"));
    await symlink(root, join(root, "alias"));
    await invalid(
      createUsHostedFileReader("api", { ...dependencies, root: join(root, "alias") }).read(
        "database-password",
      ),
    );
    await rename(join(root, privateName), join(root, "saved"));
    await mkdir(join(root, privateName));
    await invalid(reader.read("database-password"));
  });
  it("refuses a FIFO without waiting for a writer", async () => {
    await rm(join(root, privateName));
    execFileSync("mkfifo", ["-m", "440", join(root, privateName)], { timeout: 2000 });
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
  });
  it.each([0, 4097])("refuses private byte size %i", async (size) => {
    await chmod(join(root, privateName), 0o640);
    await writeFile(join(root, privateName), Buffer.alloc(size, 0x78));
    await chmod(join(root, privateName), 0o440);
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
  });
  it("admits the exact private and public caps", async () => {
    await chmod(join(root, privateName), 0o640);
    await writeFile(join(root, privateName), Buffer.alloc(4096, 0x78));
    await chmod(join(root, privateName), 0o440);
    await writeFile(join(root, "api-cert.pem"), Buffer.alloc(65536, 0x78), { mode: 0o444 });
    const reader = createUsHostedFileReader("api", dependencies);
    expect((await reader.read("database-password")).length).toBe(4096);
    expect((await reader.read("api-certificate")).length).toBe(65536);
  });
  it("rejects final replacement after open", async () => {
    afterOpen = async () => {
      await rename(join(root, privateName), join(root, "old"));
      await writeFile(join(root, privateName), bytes, { mode: 0o440 });
    };
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
    expect(lastBuffer?.every((byte) => byte === 0)).toBe(true);
  });
  it.each(["grow", "truncate", "same-size"])("rejects %s during the actual read", async (kind) => {
    afterRead = async () => {
      await chmod(join(root, privateName), 0o640);
      await writeFile(
        join(root, privateName),
        Buffer.alloc(kind === "grow" ? 128 : kind === "truncate" ? 1 : bytes.length, 0x79),
      );
      await chmod(join(root, privateName), 0o440);
    };
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
    expect(lastBuffer?.every((byte) => byte === 0)).toBe(true);
  });
  it.each(["read", "close"])("redacts %s failure and returns no buffer", async (kind) => {
    failRead = kind === "read";
    failClose = kind === "close";
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
    expect(lastBuffer?.every((byte) => byte === 0)).toBe(true);
  });
  it("redacts open and handle-stat failures with exact descriptor ownership", async () => {
    const denied: UsHostedFileIO = {
      ...io,
      async open() {
        throw new Error("synthetic-secret-canary");
      },
    };
    await invalid(
      createUsHostedFileReader("api", { ...dependencies, io: denied }).read("database-password"),
    );
    expect(opened).toBe(0);
    changeStat = () => {
      throw new Error("synthetic-secret-canary");
    };
    await invalid(createUsHostedFileReader("api", dependencies).read("database-password"));
    expect(closed).toBe(1);
  });
});
