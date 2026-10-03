import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "@markiro/db";
import { UsRuntime } from "../src/deployment/us-runtime";
import { loadUsPlanArtifactStorageConfig } from "../src/modules/traceability/plans/us-plan-artifact-config";
import { loadUsDevelopmentEnv } from "../src/deployment/entry-policy";

const fixture = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "test",
  MARKIRO_DEPLOYMENT_EDITION: "US",
  US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
  US_PLAN_ARTIFACT_S3_BUCKET: "markiro-us-plan-artifacts",
  US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-us-artifact-access",
  US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-us-artifact-secret",
  US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
});

describe("US private plan artifact configuration", () => {
  it.each([false, true])(
    "owns runtime plan services with private storage configured=%s",
    async (configured) => {
      const raw = parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));
      const env = loadUsDevelopmentEnv({
        ...raw,
        ...(configured ? fixture() : {}),
        NODE_ENV: "test",
      });
      const connection = createDb(env.DATABASE_URL);
      const transport = { send: vi.fn(), destroy: vi.fn() };
      const runtime = new UsRuntime(env, connection, transport);
      const close = runtime.planArtifactStorage
        ? vi.spyOn(runtime.planArtifactStorage, "onModuleDestroy")
        : null;
      try {
        expect(runtime.planDrafts).toBeDefined();
        expect(runtime.planRead).toBeDefined();
        expect(runtime.planInspection).toBeDefined();
        expect(runtime.planApproval).toBeDefined();
        expect(Boolean(runtime.planArtifactStorage)).toBe(configured);
        expect(transport.send).not.toHaveBeenCalled();
        const query = vi.spyOn(connection.pool, "query").mockResolvedValue(undefined);
        await runtime.assertDatabaseReady();
        expect(query.mock.calls[0]?.[0]).toContain("traceability_plan_versions plan");
        expect(query.mock.calls[0]?.[0]).toContain("traceability_plan_cleanup_fences plan_fence");
        expect(query.mock.calls[0]?.[0]).toContain("plan_fence.state");
      } finally {
        await runtime.onApplicationShutdown();
      }
      if (close) expect(close).toHaveBeenCalledOnce();
      // Injected transports remain caller-owned; the default owned S3 client is
      // closed by the adapter's existing lifecycle contract.
      expect(transport.destroy).not.toHaveBeenCalled();
    },
  );
  it("keeps approval storage unavailable without explicit US inputs, despite shared S3 inputs", () => {
    expect(
      loadUsPlanArtifactStorageConfig({ NODE_ENV: "test", S3_BUCKET: "ru-private" }),
    ).toBeNull();
    expect(loadUsPlanArtifactStorageConfig(fixture())?.bucket).toBe("markiro-us-plan-artifacts");
  });

  it.each(Object.keys(fixture()).filter((key) => key.startsWith("US_PLAN_ARTIFACT_")))(
    "rejects partial configuration missing %s without fallback",
    (key) => {
      const raw = { ...fixture(), [key]: "", S3_BUCKET: "ru-private" };
      expect(() => loadUsPlanArtifactStorageConfig(raw)).toThrow(
        "us_plan_artifact_configuration_invalid",
      );
    },
  );

  it.each([
    ["MARKIRO_DEPLOYMENT_EDITION", "RU"],
    ["US_PLAN_ARTIFACT_S3_ENDPOINT", "https://storage.example.com"],
    ["US_PLAN_ARTIFACT_S3_ENDPOINT", "http://private-user:private-secret@127.0.0.1:19000"],
    ["US_PLAN_ARTIFACT_S3_ENDPOINT", "http://127.0.0.1:19000/?target=elsewhere"],
    ["US_PLAN_ARTIFACT_S3_BUCKET", "../ru-private"],
    ["US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE", "yes"],
    ["S3_BUCKET", "markiro-us-plan-artifacts"],
    ["S3_ACCESS_KEY_ID", "synthetic-us-artifact-access"],
  ])("rejects ambiguous/unsafe %s with secret-free diagnostics", (key, value) => {
    expect(() => loadUsPlanArtifactStorageConfig({ ...fixture(), [key]: value })).toThrow(
      /^us_plan_artifact_configuration_invalid$/,
    );
  });

  it.each([{}, fixture()])(
    "refuses production approval readiness regardless of configuration",
    (raw) => {
      expect(() => loadUsPlanArtifactStorageConfig({ ...raw, NODE_ENV: "production" })).toThrow(
        "us_plan_artifact_operational_verification_required",
      );
    },
  );

  it("validates optional US storage at the isolated entry boundary", () => {
    const raw = parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));
    expect(() =>
      loadUsDevelopmentEnv({ ...raw, ...fixture(), NODE_ENV: "development" }),
    ).not.toThrow();
    expect(() =>
      loadUsDevelopmentEnv({ ...raw, US_PLAN_ARTIFACT_S3_ENDPOINT: "https://storage.example.com" }),
    ).toThrow();
  });
});
