import { describe, expect, it } from "vitest";
import {
  assertUsRequestPackageArtifactStorageConfig,
  loadUsRequestPackageArtifactStorageConfig,
} from "../src/modules/traceability/requests/us-request-package-artifact-config";
import { UsRequestPackageArtifactStore } from "../src/modules/traceability/requests/us-request-package-artifacts";
import { classifyUsWorkerFailure } from "../src/modules/traceability/requests/us-request-worker-failures";
import { storageEnvironment } from "./support/us-request-worker-storage-fixture";

describe("US request package configuration authority", () => {
  it("keeps missing US storage unavailable despite primary storage fields", () => {
    expect(
      loadUsRequestPackageArtifactStorageConfig({ NODE_ENV: "test", S3_BUCKET: "primary" }),
    ).toBeNull();
    expect(() =>
      loadUsRequestPackageArtifactStorageConfig({
        ...storageEnvironment(),
        US_REQUEST_PACKAGE_S3_REGION: "  ",
      }),
    ).toThrow("us_request_package_storage_configuration_invalid");
  });

  it.each(Object.keys(storageEnvironment()).filter((key) => key.startsWith("US_REQUEST_PACKAGE_")))(
    "rejects partial configuration missing %s",
    (key) => {
      const source = storageEnvironment();
      delete source[key];
      expect(() => loadUsRequestPackageArtifactStorageConfig(source)).toThrow(
        /^us_request_package_storage_configuration_invalid$/,
      );
    },
  );

  it.each([
    ["MARKIRO_DEPLOYMENT_EDITION", "RU"],
    ["MARKIRO_DEPLOYMENT_EDITION", ""],
    ["NODE_ENV", ""],
    ["US_REQUEST_PACKAGE_S3_ENDPOINT", "https://storage.example.com"],
    ["US_REQUEST_PACKAGE_S3_ENDPOINT", "http://127.0.0.1:9000"],
    ["US_REQUEST_PACKAGE_S3_ENDPOINT", "http://secret:private@127.0.0.1:19000"],
    ["US_REQUEST_PACKAGE_S3_ENDPOINT", "http://127.0.0.1:19000/?key=secret"],
    ["US_REQUEST_PACKAGE_S3_ENDPOINT", "http://127.0.0.1:19000/#secret"],
    ["US_REQUEST_PACKAGE_S3_ENDPOINT", "http://127.0.0.1:19000/private"],
    ["US_REQUEST_PACKAGE_S3_REGION", ""],
    ["US_REQUEST_PACKAGE_S3_BUCKET", "../private"],
    ["US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE", "false"],
    ["S3_BUCKET", "markiro-us-request-fixture"],
    ["S3_ACCESS_KEY_ID", "synthetic-us-request-access"],
    ["S3_SECRET_ACCESS_KEY", "synthetic-us-request-secret"],
  ])("rejects unsafe %s without leaking its value", (key, value) => {
    expect(() =>
      loadUsRequestPackageArtifactStorageConfig({ ...storageEnvironment(), [key]: value }),
    ).toThrow(/^us_request_package_storage_configuration_invalid$/);
  });

  it.each([{}, storageEnvironment()])("rejects production before availability", (source) => {
    expect(() =>
      loadUsRequestPackageArtifactStorageConfig({ ...source, NODE_ENV: "production" }),
    ).toThrow(/^us_request_package_storage_operational_verification_required$/);
  });

  it.each([
    [
      { ...storageEnvironment(), NODE_ENV: "production" },
      "us_request_package_storage_operational_verification_required",
    ],
    [
      { ...storageEnvironment(), MARKIRO_DEPLOYMENT_EDITION: "RU" },
      "us_request_package_storage_configuration_invalid",
    ],
  ] as const)("retains finite configuration failure identity for the worker", (source, code) => {
    let thrown: unknown;
    try {
      loadUsRequestPackageArtifactStorageConfig(source);
    } catch (error) {
      thrown = error;
    }
    expect(classifyUsWorkerFailure(thrown)).toEqual({ code, retryable: false });
  });

  it.each(["http://127.0.0.1:19000", "http://localhost:19000", "http://[::1]:19000"])(
    "accepts the existing isolated host %s and freezes loader authority",
    (endpoint) => {
      const config = loadUsRequestPackageArtifactStorageConfig({
        ...storageEnvironment(),
        US_REQUEST_PACKAGE_S3_ENDPOINT: endpoint,
      });
      if (!config) throw new Error("fixture unavailable");
      expect(Object.isFrozen(config)).toBe(true);
      expect(() => assertUsRequestPackageArtifactStorageConfig(config)).not.toThrow();
      expect(
        () => new UsRequestPackageArtifactStore({ ...config }, { send: async () => undefined }),
      ).toThrow(/^us_request_package_storage_configuration_invalid$/);
    },
  );
});
