import assert from "node:assert/strict";
import test from "node:test";
import { createPlatformManifest } from "../release-manifest.mjs";
import { validateHealthyForwardPublisherDelta } from "../host/healthy-forward-publisher-policy.mjs";

const repository = "thevladbog/markiro";
const identity = { repository, repositoryId: "1", ownerId: "2" };
const legacy = {
  product: "handheld",
  environment: "handheld-release",
  workflowRef: `${repository}/.github/workflows/handheld-release.yml@refs/heads/main`,
  workflowSha: "a".repeat(40),
  subject: `repo:${repository}:environment:handheld-release`,
};

function fixtures(products = ["handheld", "standalone"]) {
  const approved = {
    ...identity,
    workflows: products.map((product) => {
      const environment = `${product}-stable-publisher`;
      const workflowRef = `${repository}/.github/workflows/${product}-stable-release.yml@refs/tags/${product}-publisher-v1`;
      return {
        product,
        mode: "pinned-tag",
        environment,
        workflowRef,
        jobWorkflowRef: workflowRef,
        workflowSha: "b".repeat(40),
        jobWorkflowSha: "b".repeat(40),
        subject: `repo:${repository}:environment:${environment}`,
      };
    }),
  };
  const manifest = createPlatformManifest({
    sourceSha: "c".repeat(40),
    toolingSha: "c".repeat(40),
    apiDigest: `sha256:${"c".repeat(64)}`,
    edgeDigest: `sha256:${"d".repeat(64)}`,
    createdAt: "2026-11-12T16:00:00.000Z",
    workflowRunId: "123",
  });
  const before = {
    MARKIRO_SOURCE_SHA: "a".repeat(40),
    MARKIRO_TOOLING_SHA: "a".repeat(40),
    MARKIRO_API_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: `sha256:${"b".repeat(64)}`,
    MARKIRO_RELEASES_BUCKET: "markiro-releases",
    DATABASE_URL: "postgres://synthetic-password@postgres/platform",
    RELEASE_CATALOG_S3_ENDPOINT: "https://s3.twcstorage.ru",
    RELEASE_CATALOG_S3_REGION: "ru-1",
    RELEASE_CATALOG_S3_BUCKET: "markiro-releases",
    RELEASE_CATALOG_S3_ACCESS_KEY_ID: "fixture",
    RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "private-fixture",
    RELEASE_CATALOG_CACHE_DIR: "/opt/markiro-platform/release-catalog/cache",
    RELEASE_CATALOG_JOURNAL_DIR: "/opt/markiro-platform/release-catalog/journal",
    RELEASE_CATALOG_CACHE_BYTES: "1048576",
    RELEASE_CATALOG_OBJECT_BYTES: "524288",
    RELEASE_CATALOG_DISK_RESERVE_BYTES: "1048576",
    RELEASE_CATALOG_DOWNLOADS: "2",
    RELEASE_CATALOG_TIMEOUT_MS: "30000",
    RELEASE_CATALOG_WRITERS_ENABLED: "true",
    RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify({ ...identity, workflows: [legacy] }),
  };
  const after = {
    ...before,
    MARKIRO_SOURCE_SHA: manifest.sourceSha,
    MARKIRO_TOOLING_SHA: manifest.toolingSha,
    MARKIRO_API_IMAGE_DIGEST: manifest.api.split("@")[1],
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: manifest.edge.split("@")[1],
    RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify({
      ...identity,
      workflows: [legacy, ...approved.workflows],
    }),
  };
  return { before, after, manifest, approved };
}

test("binds the image pair and adds only the two approved publisher pins", () => {
  const { before, after, manifest, approved } = fixtures();
  assert.doesNotThrow(() =>
    validateHealthyForwardPublisherDelta(before, after, manifest, approved),
  );
  const wrongImage = { ...after, MARKIRO_API_IMAGE_DIGEST: before.MARKIRO_API_IMAGE_DIGEST };
  assert.throws(() => validateHealthyForwardPublisherDelta(before, wrongImage, manifest, approved));
});

test("admits either reviewed stable publisher separately", () => {
  for (const product of ["handheld", "standalone"]) {
    const { before, after, manifest, approved } = fixtures([product]);
    assert.doesNotThrow(() =>
      validateHealthyForwardPublisherDelta(before, after, manifest, approved),
    );
  }
});

test("rejects empty approval and multiple approved tags for one product", () => {
  const empty = fixtures([]);
  assert.throws(() =>
    validateHealthyForwardPublisherDelta(empty.before, empty.after, empty.manifest, empty.approved),
  );

  const { before, after, manifest, approved } = fixtures(["handheld", "handheld"]);
  const duplicate = approved.workflows[1];
  duplicate.workflowRef = duplicate.jobWorkflowRef = duplicate.workflowRef.replace(/-v1$/u, "-v2");
  after.RELEASE_CATALOG_PUBLISHERS_JSON = JSON.stringify({
    ...identity,
    workflows: [legacy, ...approved.workflows],
  });
  assert.throws(() => validateHealthyForwardPublisherDelta(before, after, manifest, approved));
});

test("refuses changes to the database, storage credentials, or writer switch without exposing values", () => {
  const { before, after, manifest, approved } = fixtures();
  for (const patch of [
    { DATABASE_URL: "postgres://replacement-private-value@postgres/platform" },
    { RELEASE_CATALOG_S3_SECRET_ACCESS_KEY: "replacement-private-value" },
    { RELEASE_CATALOG_WRITERS_ENABLED: "false" },
  ]) {
    assert.throws(
      () =>
        validateHealthyForwardPublisherDelta(before, { ...after, ...patch }, manifest, approved),
      (error) =>
        error.code === "ERR_HEALTHY_FORWARD_PUBLISHER_DELTA" && !error.message.includes("private"),
    );
  }
});

test("refuses to replace a legacy publisher or admit an unapproved stable tag", () => {
  const { before, after, manifest, approved } = fixtures();
  for (const edit of [
    (config) => {
      config.workflows[0].workflowSha = "e".repeat(40);
    },
    (config) => {
      config.workflows[1].workflowSha = config.workflows[1].jobWorkflowSha = "e".repeat(40);
    },
    (config) => {
      config.workflows.pop();
    },
  ]) {
    const config = JSON.parse(after.RELEASE_CATALOG_PUBLISHERS_JSON);
    edit(config);
    assert.throws(() =>
      validateHealthyForwardPublisherDelta(
        before,
        {
          ...after,
          RELEASE_CATALOG_PUBLISHERS_JSON: JSON.stringify(config),
        },
        manifest,
        approved,
      ),
    );
  }
});
