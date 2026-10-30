import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import type { DbPoolOptions } from "../src/client.js";
import { createDb } from "../src/client.js";
const mocks = vi.hoisted(() => ({ pool: vi.fn(), drizzle: vi.fn() }));
vi.mock("pg", () => ({ default: { Pool: mocks.pool } }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: mocks.drizzle }));
type Assert<T extends true> = T;
const supportsTls: Assert<"ssl" extends keyof DbPoolOptions ? true : false> = true;
beforeEach(() => {
  mocks.pool.mockReset();
  mocks.drizzle.mockReset();
  mocks.pool.mockImplementation(function Pool() {
    return { owned: true };
  });
  mocks.drizzle.mockReturnValue({ wrapped: true });
});
it("passes explicit TLS options to the driver without changing ordinary options", () => {
  expect(supportsTls).toBe(true);
  const ssl = {
    ca: "synthetic CA",
    rejectUnauthorized: true,
    servername: "postgres.us-demo.internal",
  } as const;
  createDb("postgres://fixture@fixture.invalid/fixture", { max: 2, ssl });
  expect(mocks.pool).toHaveBeenCalledExactlyOnceWith({
    connectionString: "postgres://fixture@fixture.invalid/fixture",
    max: 2,
    ssl,
  });
  expect(mocks.drizzle).toHaveBeenCalledExactlyOnceWith({ owned: true });
});
it("preserves existing calls with no TLS option", () => {
  createDb("postgres://fixture@fixture.invalid/fixture", { max: 5, statement_timeout: 5000 });
  expect(mocks.pool).toHaveBeenCalledExactlyOnceWith({
    connectionString: "postgres://fixture@fixture.invalid/fixture",
    max: 5,
    statement_timeout: 5000,
  });
});

type Tls = NonNullable<DbPoolOptions["ssl"]>;
const noInsecure: Assert<
  { ca: string; rejectUnauthorized: false; servername: string } extends Tls ? false : true
> = true;
it("requires certificate verification in the explicit TLS type", () => {
  expect(noInsecure).toBe(true);
});
it("preserves the complete original database implementation bytes", () => {
  const source = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
  const addition =
    "  ssl?: Readonly<{ ca: string; rejectUnauthorized: true; servername: string }>;\n";
  expect(source.split(addition)).toHaveLength(2);
  expect(createHash("sha256").update(source.replace(addition, "")).digest("hex")).toBe(
    "16d11b6298ea2ad192c2c00261c764a4e178cf92e019bc3c85514e32383a62a9",
  );
});
