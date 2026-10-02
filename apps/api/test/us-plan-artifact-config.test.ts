import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
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
