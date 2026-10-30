import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ServiceUnavailableException } from "@nestjs/common";
import { expect, it } from "vitest";
import type { UsBusinessRuntimeView } from "../src/deployment/us-business-runtime-view";
import { UsHostedRequestHttpRuntime } from "../src/deployment/us-hosted-request-http-runtime";

it("refuses forged owners before constructing read/download/command stores", () => {
  // @ts-expect-error Invalid database must be unobserved behind the owner boundary.
  expect(() => new UsHostedRequestHttpRuntime(undefined, {}, {})).toThrow(
    ServiceUnavailableException,
  );
});
const compatible: UsHostedRequestHttpRuntime extends UsBusinessRuntimeView["requestHttp"]
  ? true
  : false = true;
it("implements the exact readonly request consumer view", () => {
  expect(compatible).toBe(true);
});

it("preserves the original request-detail schema/response logic", () => {
  const local = readFileSync(
    resolve(__dirname, "../src/deployment/us-request-http-runtime.ts"),
    "utf8",
  );
  const hosted = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-request-http-runtime.ts"),
    "utf8",
  );
  const get = (source: string) => {
    const a = source.indexOf("  async get(");
    const b = source.indexOf("  dispose():", a);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return source.slice(a, b);
  };
  expect(
    get(hosted)
      .replace("    assertUsHostedRequestHttpResources(this.#resources);\n", "")
      .replaceAll("this.#resources", "this.resources"),
  ).toBe(get(local));
  expect(createHash("sha256").update(local).digest("hex")).toBe(
    "3a287144feaceafc4f0edbcebd50929e8d01ed6a2970da12457d3c00e1b072ef",
  );
});
