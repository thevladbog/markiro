import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { UsPlanArtifactStore } from "../src/modules/traceability/plans/us-plan-artifacts";
import { loadUsPlanArtifactStorageConfig } from "../src/modules/traceability/plans/us-plan-artifact-config";

it("requires genuine release and material for hosted construction", () => {
  expect(() => UsPlanArtifactStore.createHosted({}, {})).toThrow("us_plan_artifact_hosted_invalid");
  // @ts-expect-error An unregistered empty construction cannot name the private overload type.
  expect(() => new UsPlanArtifactStore(Object.freeze({}))).toThrow(
    "us_plan_artifact_configuration_invalid",
  );
});
it("keeps injected local clients caller-owned and still refuses structural configs", () => {
  const config = loadUsPlanArtifactStorageConfig({
    MARKIRO_DEPLOYMENT_EDITION: "US",
    NODE_ENV: "test",
    US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
    US_PLAN_ARTIFACT_S3_REGION: "test",
    US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-plan-test",
    US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-access",
    US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-secret",
    US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
  });
  if (!config) throw new Error("missing local fixture");
  const client = { send: vi.fn(), destroy: vi.fn() };
  const store = new UsPlanArtifactStore(config, client);
  store.onModuleDestroy();
  expect(client.destroy).not.toHaveBeenCalled();
  expect(() => new UsPlanArtifactStore({ ...config }, client)).toThrow(
    "us_plan_artifact_configuration_invalid",
  );
});

it("restores every original local constructor and operation byte through the reviewed inverse", () => {
  let source = readFileSync(
    resolve(__dirname, "../src/modules/traceability/plans/us-plan-artifacts.ts"),
    "utf8",
  );
  function remove(start: string, end: string, replacement = "") {
    expect(source.split(start)).toHaveLength(2);
    expect(source.split(end)).toHaveLength(2);
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    expect(last).toBeGreaterThan(first);
    source = source.slice(0, first) + replacement + source.slice(last + end.length);
  }
  remove("// Hosted store imports.\n", "// End hosted store imports.\n");
  remove("// Hosted construction admission.\n", "// End hosted construction admission.\n\n");
  remove("  // Hosted private state.\n", "  // End hosted private state.\n");
  remove(
    "  // Hosted constructor admission.\n",
    "    // End hosted constructor admission.\n",
    `  constructor(
    private readonly config: UsPlanArtifactStorageConfig,
    client?: UsPlanArtifactS3Transport,
  ) {
    assertUsPlanArtifactStorageConfig(config);
`,
  );
  remove(
    "  // Hosted factory and operation boundary.\n",
    "  // End hosted factory and operation boundary.\n\n",
  );
  const disposal =
    "    // Hosted disposal boundary.\n    if (this.#hosted) this.#hosted.disposed = true;\n";
  expect(source.split(disposal)).toHaveLength(2);
  source = source.replace(disposal, "");
  const admission = "    // Hosted operation admission.\n    this.#assertHosted();\n";
  expect(source.split(admission)).toHaveLength(5);
  source = source
    .split(admission)
    .join("")
    .replaceAll("this.#config", "this.config")
    .replaceAll("this.#send(", "this.#client.send(");
  for (const [command, indent] of [
    ["DeleteObjectCommand", "              "],
    ["HeadObjectCommand", "                "],
  ] as const) {
    const expanded = `new ${command}({\n${indent}Bucket: this.config.bucket,\n${indent}Key: record.artifact.objectKey,\n${indent.slice(2)}})`;
    expect(source.split(expanded)).toHaveLength(2);
    source = source.replace(
      expanded,
      `new ${command}({ Bucket: this.config.bucket, Key: record.artifact.objectKey })`,
    );
  }
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "d152f1a682ed658e4b1a1628285849a0762912dc3cdee563f11d62da4a03419d",
  );
});
