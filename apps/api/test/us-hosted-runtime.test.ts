import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ServiceUnavailableException } from "@nestjs/common";
import { expect, it } from "vitest";
import type { UsBusinessRuntimeView } from "../src/deployment/us-business-runtime-view";
import type { UsHttpRuntime } from "../src/deployment/us-http-runtime";
import { UsHostedRuntime } from "../src/deployment/us-hosted-runtime";

it("refuses forged owners before observing a database or constructing auth/stores", () => {
  // @ts-expect-error Invalid connection must remain unobserved behind owner admission.
  expect(() => new UsHostedRuntime({}, {}, undefined)).toThrow(ServiceUnavailableException);
});
const business: UsHostedRuntime extends UsBusinessRuntimeView ? true : false = true;
const http: UsHostedRuntime extends UsHttpRuntime ? true : false = true;
const dbOnly: Exclude<keyof UsHostedRuntime["connection"], "db"> extends never ? true : false =
  true;
const originsOnly: Exclude<
  keyof UsHostedRuntime["env"],
  "BETTER_AUTH_URL" | "ADMIN_ORIGIN"
> extends never
  ? true
  : false = true;
it("implements the two exact consumer views without exposing a pool or full environment", () => {
  expect([business, http, dbOnly, originsOnly]).toEqual([true, true, true, true]);
});
it("keeps deployment readiness refused until the separate provisioning contract exists", () => {
  expect(() => UsHostedRuntime.prototype.assertDeploymentReady()).toThrow(
    ServiceUnavailableException,
  );
  try {
    UsHostedRuntime.prototype.assertDeploymentReady();
  } catch (error) {
    if (!(error instanceof ServiceUnavailableException)) throw error;
    expect(error.getResponse()).toEqual({ code: "us_hosted_provisioning_required" });
  }
});

it("preserves original schema preflight SQL, database error mapping and shutdown teardown sequence", () => {
  const local = readFileSync(resolve(__dirname, "../src/deployment/us-runtime.ts"), "utf8");
  const hosted = readFileSync(resolve(__dirname, "../src/deployment/us-hosted-runtime.ts"), "utf8");
  const section = (source: string, start: string, end: string) => {
    const a = source.indexOf(start);
    const b = source.indexOf(end, a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return source.slice(a, b);
  };
  const ready = (source: string) =>
    section(
      source,
      "  async assertDatabaseReady(): Promise<void> {",
      "  async databaseOperation<T>",
    );
  expect(ready(hosted).replaceAll("this.#connection.pool", "this.connection.pool")).toBe(
    ready(local),
  );
  const operation = (source: string) =>
    source.slice(source.indexOf("  async databaseOperation<T>"));
  expect(operation(hosted).replace("      this.#assertOwners();\n", "")).toBe(operation(local));
  const shutdown = (source: string) =>
    section(source, "  onApplicationShutdown(): Promise<void> {", "  /** Read-only preflight.");
  const restored = shutdown(hosted)
    .replace(
      "    // Nest must finish native listener/request settlement before this hook tears down clients.\n    this.#stopping = true;\n",
      "",
    )
    .replaceAll("this.#shutdown", "this.shutdown")
    .replaceAll("this.#connection.pool", "this.connection.pool")
    .replaceAll("this.#planArtifactStorage", "this.planArtifactStorage");
  expect(restored).toBe(shutdown(local));
  expect(createHash("sha256").update(local).digest("hex")).toBe(
    "b3fa8e3d0c2ff525e9cf572e8f567aa59ad629e91b10902337d03ce564b27b1d",
  );
});
