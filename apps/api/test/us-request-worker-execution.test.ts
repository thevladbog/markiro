import { canonicalExportDigest } from "@markiro/domain";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureUsRequestBuildDescriptor,
  loadUsRequestBuildDescriptor,
} from "../src/deployment/us-request-build-descriptor";
import { createUsRequestBuildFixture, localBuildEnv } from "./support/us-request-build-fixture";

const build = { apiVersion: "test-us09-package", gitSha: "a".repeat(40), dirty: false };
const environment = { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "US" };
const load = () => import("../src/modules/traceability/requests/us-request-worker-execution");

describe("synthetic US worker execution authority", () => {
  it("accepts only checked descriptor authority and preserves the existing synthetic digest", async () => {
    const fixture = await createUsRequestBuildFixture();
    try {
      const source = await localBuildEnv();
      await fixture.writeDocument(
        await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots),
      );
      const descriptor = await loadUsRequestBuildDescriptor(source, fixture.roots);
      const module = await load();
      const identity = module.createUsRequestRuntimeExecutionIdentity(descriptor, source);
      expect(identity).toEqual(
        module.createSyntheticUsRequestExecutionIdentity(fixture.cleanBuild, source),
      );
      expect(() =>
        module.createUsRequestRuntimeExecutionIdentity({ ...descriptor }, source),
      ).toThrow();
      expect(() =>
        module.createUsRequestRuntimeExecutionIdentity(descriptor, {
          ...source,
          NODE_ENV: "production",
        }),
      ).toThrow();
    } finally {
      await fixture.dispose();
    }
  });
  it("copies and freezes build identity and binds pinned byte-path versions", async () => {
    const module = await load();
    const supplied = { ...build };
    const identity = module.createSyntheticUsRequestExecutionIdentity(supplied, environment);
    supplied.apiVersion = "changed";
    expect(identity.build).toEqual(build);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.build)).toBe(true);
    expect(identity.digest).toBe(
      canonicalExportDigest({
        schemaVersion: 1,
        executionKind: "synthetic-us-development",
        build,
        packageVersion: "us-request-package-v1",
        reportVersion: "us-request-report-pdf-v1",
        libraries: { "@react-pdf/renderer": "4.6.1", "write-excel-file": "4.1.1", fflate: "0.8.3" },
      }),
    );
    expect(() => module.assertUsRequestWorkerExecutionIdentity(identity)).not.toThrow();
    expect(() => module.assertUsRequestWorkerExecutionIdentity({ ...identity })).toThrow();
  });

  it.each([
    {},
    { NODE_ENV: "production", MARKIRO_DEPLOYMENT_EDITION: "US" },
    { NODE_ENV: "test", MARKIRO_DEPLOYMENT_EDITION: "RU" },
    { NODE_ENV: "test" },
  ])("rejects unavailable or operational environment %j", async (source) => {
    const module = await load();
    expect(() => module.createSyntheticUsRequestExecutionIdentity(build, source)).toThrow(
      expect.objectContaining({ response: { code: "us_request_worker_execution_invalid" } }),
    );
  });

  it("rejects malformed build and does not reread a mutable environment after loading", async () => {
    const module = await load();
    expect(() =>
      module.createSyntheticUsRequestExecutionIdentity({ ...build, gitSha: "bad" }, environment),
    ).toThrow();
    const source = { ...environment };
    const identity = module.createSyntheticUsRequestExecutionIdentity(build, source);
    source.NODE_ENV = "production";
    expect(() => module.assertUsRequestWorkerExecutionIdentity(identity)).not.toThrow();
  });
  it("stays absent from the US runtime and startup composition", async () => {
    for (const path of [
      "src/deployment/us-runtime.ts",
      "src/deployment/us-development.module.ts",
      "src/main.us.ts",
    ])
      expect(await readFile(resolve(path), "utf8")).not.toMatch(
        /us-request-worker|UsRequestWorker/,
      );
  });
});
