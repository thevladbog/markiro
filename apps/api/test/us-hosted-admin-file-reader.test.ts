import { constants, statSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { createUsHostedAdminFileReader } from "../src/deployment/us-hosted-admin-file-reader";

// Non-authoritative unit protocol only; genuine release/native material acceptance is separate.
const unit = vi.hoisted(() => ({
  token: Object.freeze({ unitOnly: true }),
  operation: "migrate" as "migrate" | "seed" | "provision",
  live: true,
  bytes: new Map<string, Buffer>(),
  versions: new Map<string, bigint>(),
  modes: new Map<string, bigint>(),
  owners: new Map<string, bigint>(),
  opens: [] as string[],
  flags: [] as number[],
  closed: 0,
  buffers: [] as Buffer[],
  short: false,
}));
vi.mock("../src/deployment/us-hosted-admin-release", () => ({
  assertUsHostedAdminRelease(value: unknown) {
    if (value !== unit.token || !unit.live) throw Error("private-unit-canary");
  },
  usHostedAdminReleaseIdentity(value: unknown) {
    if (value !== unit.token || !unit.live) throw Error("private-unit-canary");
    return { operation: unit.operation, config: { operation: unit.operation } };
  },
}));
vi.mock("node:fs/promises", () => {
  const stats = (path: string) => {
    const result = statSync(__filename, { bigint: true });
    const directory = ["/run", "/run/secrets", "/run/secrets/us-demo"].includes(path);
    result.mode = unit.modes.get(path) ?? (directory ? 0o40555n : 0o100440n);
    result.uid = unit.owners.get(path) ?? 0n;
    result.gid = BigInt(process.getgid?.() ?? -1);
    result.size = directory ? 4096n : BigInt(unit.bytes.get(path)?.length ?? 0);
    result.mtimeNs = unit.versions.get(path) ?? 1n;
    result.ctimeNs = 1n;
    return result;
  };
  return {
    lstat: vi.fn(async (path: string) => stats(path)),
    open: vi.fn(async (path: string, flags: number) => {
      unit.opens.push(path);
      unit.flags.push(flags);
      const source = unit.bytes.get(path);
      if (!source) throw Error("private-unit-file-missing");
      return {
        stat: async () => stats(path),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          unit.buffers.push(buffer);
          const available = Math.max(0, source.length - position - Number(unit.short));
          const bytesRead = Math.min(length, available);
          source.copy(buffer, offset, position, position + bytesRead);
          return { bytesRead, buffer };
        },
        close: async () => {
          unit.closed++;
        },
      };
    }),
  };
});

const root = "/run/secrets/us-demo/";
beforeEach(() => {
  unit.operation = "migrate";
  unit.live = true;
  unit.bytes.clear();
  unit.versions.clear();
  unit.modes.clear();
  unit.owners.clear();
  unit.opens.length = 0;
  unit.flags.length = 0;
  unit.buffers.length = 0;
  unit.closed = 0;
  unit.short = false;
  for (const op of ["migrate", "seed", "provision"])
    unit.bytes.set(root + `admin-${op}-db-password`, Buffer.from("synthetic-unit-password\n"));
  for (const name of [
    "db-ca.pem",
    "storage-ca.pem",
    "admin-seed-storage-access-key",
    "admin-seed-storage-secret-key",
  ])
    unit.bytes.set(root + name, Buffer.from("synthetic-unit-material\n"));
});

it.each(["migrate", "seed", "provision"] as const)(
  "selects only %s protected files",
  async (operation) => {
    unit.operation = operation;
    const reader = createUsHostedAdminFileReader(unit.token);
    const bytes = await reader.read("database-password");
    expect(unit.opens).toEqual([root + `admin-${operation}-db-password`]);
    expect(unit.flags).toEqual([constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK]);
    expect(unit.closed).toBe(1);
    expect(bytes.length).toBeGreaterThan(0);
    await reader.assertUnchanged();
    reader.dispose();
    expect(bytes.every((value) => value === 0)).toBe(true);
  },
);

it("refuses foreign authority and unknown/cross-operation names before open", async () => {
  expect(() => createUsHostedAdminFileReader({})).toThrow("us_hosted_admin_file_invalid");
  const reader = createUsHostedAdminFileReader(unit.token);
  for (const name of [
    "storage-access-key",
    "storage-secret-key",
    "storage-ca",
    "api-private-key",
    "../db-ca.pem",
  ])
    await expect(Reflect.apply(reader.read, reader, [name])).rejects.toThrow(
      "us_hosted_admin_file_invalid",
    );
  expect(unit.opens).toHaveLength(0);
  reader.dispose();
});

it("fences every acquired file and ancestor without replacing the first snapshot", async () => {
  const reader = createUsHostedAdminFileReader(unit.token);
  const first = await reader.read("database-password");
  await reader.read("database-ca");
  const opened = unit.opens.length;
  await expect(reader.read("database-password")).rejects.toThrow("us_hosted_admin_file_invalid");
  expect(unit.opens).toHaveLength(opened);
  unit.versions.set(root + "admin-migrate-db-password", 2n);
  await expect(reader.assertUnchanged()).rejects.toThrow("us_hosted_admin_file_invalid");
  reader.dispose();
  expect(first.every((value) => value === 0)).toBe(true);
});

it.each(["/run", "/run/secrets", "/run/secrets/us-demo"])(
  "refuses replaced ancestor %s at final fence",
  async (path) => {
    const reader = createUsHostedAdminFileReader(unit.token);
    await reader.read("database-password");
    unit.versions.set(path, 2n);
    await expect(reader.assertUnchanged()).rejects.toThrow("us_hosted_admin_file_invalid");
    reader.dispose();
  },
);

it.each([0o100444n, 0o100666n, 0o120440n, 0o010440n])(
  "refuses private unsafe mode/type %s and closes descriptor",
  async (mode) => {
    unit.modes.set(root + "admin-migrate-db-password", mode);
    const reader = createUsHostedAdminFileReader(unit.token);
    await expect(reader.read("database-password")).rejects.toThrow("us_hosted_admin_file_invalid");
    expect(unit.closed).toBe(1);
    reader.dispose();
  },
);

it("refuses unprotected parent, wrong owner, oversized and short bytes", async () => {
  for (const variant of ["parent", "owner", "oversized", "short"] as const) {
    unit.modes.clear();
    unit.owners.clear();
    unit.short = false;
    unit.bytes.set(root + "admin-migrate-db-password", Buffer.from("synthetic-unit-password\n"));
    if (variant === "parent") unit.modes.set("/run/secrets", 0o40777n);
    if (variant === "owner") unit.owners.set(root + "admin-migrate-db-password", 123n);
    if (variant === "oversized")
      unit.bytes.set(root + "admin-migrate-db-password", Buffer.alloc(4097, 32));
    if (variant === "short") unit.short = true;
    const reader = createUsHostedAdminFileReader(unit.token);
    await expect(reader.read("database-password")).rejects.toThrow("us_hosted_admin_file_invalid");
    reader.dispose();
  }
  expect(unit.buffers.every((buffer) => buffer.every((value) => value === 0))).toBe(true);
});

it("keeps public CA bounds separate and seed-only material closed", async () => {
  unit.operation = "seed";
  unit.modes.set(root + "db-ca.pem", 0o100444n);
  unit.bytes.set(root + "db-ca.pem", Buffer.alloc(65536, 32));
  const reader = createUsHostedAdminFileReader(unit.token);
  expect((await reader.read("database-ca")).length).toBe(65536);
  await reader.read("storage-access-key");
  await reader.read("storage-secret-key");
  await reader.read("storage-ca");
  await reader.assertUnchanged();
  reader.dispose();
});

it("refuses after dependency or reader disposal and wipes every acquired buffer", async () => {
  const reader = createUsHostedAdminFileReader(unit.token);
  const bytes = await reader.read("database-password");
  unit.live = false;
  await expect(reader.assertUnchanged()).rejects.toThrow("us_hosted_admin_file_invalid");
  reader.dispose();
  reader.dispose();
  expect(bytes.every((value) => value === 0)).toBe(true);
  await expect(reader.read("database-ca")).rejects.toThrow("us_hosted_admin_file_invalid");
});
