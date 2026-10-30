import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { UsRequestWorker } from "../src/modules/traceability/requests/us-request-worker";
import { createSyntheticUsRequestExecutionIdentity } from "../src/modules/traceability/requests/us-request-worker-execution";

it.each(["entry", "after-transaction"])(
  "checks execution liveness at %s without claiming a hosted owner",
  async (boundary) => {
    const identity = createSyntheticUsRequestExecutionIdentity(
      { apiVersion: "synthetic-boundary-test", gitSha: "a".repeat(40), dirty: false },
      { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" },
    );
    const deps = {
      execution: boundary === "entry" ? { ...identity } : identity,
      lifecycle: { assertActive: vi.fn(async () => {}) },
    };
    const transaction = vi.fn(async (callback: unknown) => {
      if (typeof callback !== "function") throw new Error("invalid transaction callback");
      await Reflect.apply(callback, undefined, [{ execute: vi.fn(async () => {}) }]);
      deps.execution = { ...identity };
    });
    const renewal = { assertHealthy: vi.fn() };
    const method: unknown = Reflect.get(UsRequestWorker.prototype, "active");
    if (typeof method !== "function") throw new Error("active boundary missing");
    const pending: unknown = Reflect.apply(method, { db: { transaction }, deps }, [{}, renewal]);
    await expect(pending).rejects.toThrow();
    expect(transaction).toHaveBeenCalledTimes(boundary === "entry" ? 0 : 1);
    expect(renewal.assertHealthy).toHaveBeenCalledTimes(boundary === "entry" ? 0 : 1);
  },
);

it("adds exactly two assertions and preserves every original worker byte", () => {
  const source = readFileSync(
    resolve(__dirname, "../src/modules/traceability/requests/us-request-worker.ts"),
    "utf8",
  );
  const first = source.indexOf("  private async active(");
  const last = source.indexOf("  private outcome(", first);
  expect(first).toBeGreaterThan(-1);
  expect(last).toBeGreaterThan(first);
  const active = source.slice(first, last);
  const check = "    assertUsRequestWorkerExecutionIdentity(this.deps.execution);\n";
  expect(active.split(check)).toHaveLength(3);
  expect(active).toContain(check + "    renewal.assertHealthy();");
  const restored = source.slice(0, first) + active.split(check).join("") + source.slice(last);
  expect(createHash("sha256").update(restored).digest("hex")).toBe(
    "e1f82e9a02cfb394962bf6c9c70efe8ba5d670927d2b0a8b3fb647140b473fb8",
  );
});
