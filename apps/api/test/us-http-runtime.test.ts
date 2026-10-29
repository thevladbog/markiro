import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UsAuth } from "../src/modules/traceability/auth/us-auth";
import type { mountUsHttp } from "../src/deployment/us-http";
import type { UsRuntime } from "../src/deployment/us-runtime";

type MinimalRuntime = Readonly<{
  auth: UsAuth;
  assertDatabaseReady: () => Promise<void>;
  env: Readonly<{ BETTER_AUTH_URL: string; ADMIN_ORIGIN: string }>;
}>;
type Assert<T extends true> = T;
const minimalAccepted: Assert<
  MinimalRuntime extends Parameters<typeof mountUsHttp>[1] ? true : false
> = true;
const existingAccepted: Assert<UsRuntime extends Parameters<typeof mountUsHttp>[1] ? true : false> =
  true;

it("accepts only transport dependencies without requiring business stores", () => {
  expect(minimalAccepted).toBe(true);
  expect(existingAccepted).toBe(true);
});

vi.mock("../src/deployment/us-runtime", () => {
  throw new Error("Runtime module evaluated");
});
vi.mock("../src/modules/traceability/auth/us-auth", () => {
  throw new Error("Auth module evaluated");
});

it("importing the erased view does not evaluate runtime or auth modules", async () => {
  const view = await import("../src/deployment/us-http-runtime");
  expect(Object.keys(view)).toEqual([]);
});

const viewImport = 'import type { UsHttpRuntime } from "./us-http-runtime";';
const oldImport = 'import type { UsRuntime } from "./us-runtime";';
const viewParameter = "runtime: UsHttpRuntime";
const oldParameter = "runtime: UsRuntime";
function restoreHttp(source: string) {
  expect(source.split(viewImport)).toHaveLength(2);
  expect(source.split(viewParameter)).toHaveLength(2);
  expect(source.includes(oldImport)).toBe(false);
  expect(source.includes(oldParameter)).toBe(false);
  const original = source.replace(viewImport, oldImport).replace(viewParameter, oldParameter);
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "a632cb06806c3263e7d77c1e8fec08761ee1e7b09dd237de8e02a66e86287727",
  );
}
const httpSource = () => readFileSync(resolve(__dirname, "../src/deployment/us-http.ts"), "utf8");
it("preserves every original HTTP executable byte", () => {
  restoreHttp(httpSource());
});
it.each([
  ["16kb", "17kb"],
  ["us_host_required", "us_host_changed"],
])("rejects transport mutation %s", (before, after) => {
  const source = httpSource();
  expect(source.includes(before)).toBe(true);
  expect(() => restoreHttp(source.replace(before, after))).toThrow();
});
