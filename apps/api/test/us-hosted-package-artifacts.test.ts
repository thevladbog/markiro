import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { UsRequestPackageArtifactStore } from "../src/modules/traceability/requests/us-request-package-artifacts";
import { loadUsRequestPackageArtifactStorageConfig } from "../src/modules/traceability/requests/us-request-package-artifact-config";
import { storageEnvironment } from "./support/us-request-worker-storage-fixture";

it("requires genuine release and material for hosted package construction", () => {
  expect(() => UsRequestPackageArtifactStore.createHosted({}, {})).toThrow(
    "us_request_package_hosted_invalid",
  );
});
it("retains local config identity and caller ownership of injected transport", () => {
  const config = loadUsRequestPackageArtifactStorageConfig(storageEnvironment());
  if (!config) throw new Error("missing local fixture");
  const client = { send: vi.fn(), destroy: vi.fn() };
  const store = new UsRequestPackageArtifactStore(config, client);
  store.destroy();
  expect(client.destroy).not.toHaveBeenCalled();
  expect(() => new UsRequestPackageArtifactStore({ ...config }, client)).toThrow(
    "us_request_package_storage_configuration_invalid",
  );
});

it("restores every original local constructor and operation byte through the reviewed inverse", () => {
  let harness = readFileSync(resolve(__dirname, "us-request-package-artifacts.test.ts"), "utf8");
  for (const line of [
    'import * as hostedReleaseVerifier from "../src/deployment/us-hosted-release-verifier";\n',
    'import * as hostedMaterialOwner from "../src/deployment/us-hosted-material-owner";\n',
  ]) {
    expect(harness.split(line)).toHaveLength(2);
    harness = harness.replace(line, "");
  }
  const mappings = `      path === "../../../deployment/us-hosted-release-verifier"\n        ? hostedReleaseVerifier\n        : path === "../../../deployment/us-hosted-material-owner"\n          ? hostedMaterialOwner\n          : path === "./us-request-package-artifact-config"\n            ? artifactConfig\n            : path === "./us-request-worker-types"\n              ? workerTypes\n              : path === "./us-request-read-observation"\n                ? requestObservation\n                : require(path),`;
  expect(harness.split(mappings)).toHaveLength(2);
  harness = harness.replace(
    mappings,
    `      path === "./us-request-package-artifact-config"\n        ? artifactConfig\n        : path === "./us-request-worker-types"\n          ? workerTypes\n          : path === "./us-request-read-observation"\n            ? requestObservation\n            : require(path),`,
  );
  expect(createHash("sha256").update(harness).digest("hex")).toBe(
    "d41fb764c06ecb1a70ef7f3506145c863d99285bc78d21066f0dacfd73d49fd5",
  );
  let source = readFileSync(
    resolve(__dirname, "../src/modules/traceability/requests/us-request-package-artifacts.ts"),
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
    private readonly config: UsRequestPackageArtifactStorageConfig,
    transport?: UsRequestPackageArtifactS3Transport,
  ) {
    assertUsRequestPackageArtifactStorageConfig(config);
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
  expect(source.split(admission)).toHaveLength(6);
  source = source
    .split(admission)
    .join("")
    .replaceAll("this.#config", "this.config")
    .replaceAll("this.#send(", "this.#client.send(");
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    "563dad9236bcfc638b85479e931ff7327c8969992d3c6f72c4d8572b1066ead1",
  );
});
