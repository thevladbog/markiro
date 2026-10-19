export const sourceSha = "a".repeat(40);
export const expected = { sourceSha, workflowRunId: "456", workflowRunAttempt: "2" };
export const digest = (letter) => `sha256:${letter.repeat(64)}`;
export function release() {
  const verified = {
    version: 1,
    serverProfile: "platform-only",
    uiProfile: "platform-only",
    ...expected,
    toolingSha: sourceSha,
    ciRunId: "123",
    ciRunAttempt: "3",
    archiveSha256: "c".repeat(64),
    images: {
      api: { tag: `ghcr.io/thevladbog/markiro-api:platform-${sourceSha}-456-2`, id: digest("b") },
      edge: {
        tag: `ghcr.io/thevladbog/markiro-platform-edge:platform-${sourceSha}-456-2`,
        id: digest("c"),
      },
    },
  };
  const createdAt = "2026-10-18T00:00:00.000Z";
  const manifest = {
    version: 1,
    serverProfile: "platform-only",
    uiProfile: "platform-only",
    sourceSha,
    toolingSha: sourceSha,
    workflowRunId: "456",
    createdAt,
    api: `ghcr.io/thevladbog/markiro-api@${digest("d")}`,
    edge: `ghcr.io/thevladbog/markiro-platform-edge@${digest("e")}`,
  };
  const evidence = {
    status: "complete",
    verified,
    published: {
      api: { ...verified.images.api, pushCompleted: true, digest: digest("d") },
      edge: { ...verified.images.edge, pushCompleted: true, digest: digest("e") },
    },
    createdAt,
  };
  return { manifest, evidence };
}
export function publisher() {
  return {
    id: 456,
    run_attempt: 2,
    name: "Publish platform images",
    path: ".github/workflows/release-platform-images.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sourceSha,
    status: "completed",
    conclusion: "success",
    repository: { id: 10, full_name: "thevladbog/markiro" },
    head_repository: { id: 10, full_name: "thevladbog/markiro" },
  };
}
export function jobs(run = publisher(), names = ["build", "publish"]) {
  return {
    total_count: names.length,
    jobs: names.map((name, index) => ({
      id: 1000 + index,
      name,
      run_id: run.id,
      run_attempt: run.run_attempt,
      head_sha: run.head_sha,
      status: "completed",
      conclusion: "success",
    })),
  };
}
export function registry(reference, id, oci = false) {
  const mediaType = oci
    ? "application/vnd.oci.image.manifest.v1+json"
    : "application/vnd.docker.distribution.manifest.v2+json";
  return {
    Ref: reference,
    Descriptor: {
      digest: reference.split("@")[1],
      mediaType,
      size: 400,
      platform: { os: "linux", architecture: "amd64" },
    },
    [oci ? "OCIManifest" : "SchemaV2Manifest"]: {
      schemaVersion: 2,
      mediaType,
      config: { digest: id },
      layers: [],
    },
  };
}
