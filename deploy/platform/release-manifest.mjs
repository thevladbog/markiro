import { createReleaseManifest, parseReleaseManifest } from "../production/release-manifest.mjs";

const keys = [
  "api",
  "createdAt",
  "edge",
  "serverProfile",
  "sourceSha",
  "toolingSha",
  "uiProfile",
  "version",
  "workflowRunId",
];
function invalid() {
  throw new Error("invalid platform release manifest");
}

export function parsePlatformManifest(text, expectedRunId) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    invalid();
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.join()
  )
    invalid();
  if (
    value.version !== 1 ||
    value.serverProfile !== "platform-only" ||
    value.uiProfile !== "platform-only" ||
    typeof value.toolingSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.toolingSha) ||
    typeof value.edge !== "string" ||
    !value.edge.startsWith("ghcr.io/thevladbog/markiro-platform-edge@")
  )
    invalid();
  // Reuse the existing strict immutable image/run/date rules without changing
  // the legacy parser or allowing this manifest into its deployment path.
  parseReleaseManifest(
    JSON.stringify({
      api: value.api,
      edge: value.edge.replace("markiro-platform-edge@", "markiro-edge@"),
      commit: value.sourceSha,
      createdAt: value.createdAt,
      workflowRunId: value.workflowRunId,
    }),
    expectedRunId,
  );
  return value;
}

export function createPlatformManifest(input) {
  if (
    !input ||
    Object.keys(input).sort().join() !==
      "apiDigest,createdAt,edgeDigest,sourceSha,toolingSha,workflowRunId"
  )
    invalid();
  const legacy = createReleaseManifest({
    releaseSha: input.sourceSha,
    apiDigest: input.apiDigest,
    edgeDigest: input.edgeDigest,
    createdAt: input.createdAt,
    workflowRunId: input.workflowRunId,
  });
  return parsePlatformManifest(
    JSON.stringify({
      version: 1,
      serverProfile: "platform-only",
      uiProfile: "platform-only",
      sourceSha: legacy.commit,
      toolingSha: input.toolingSha,
      api: legacy.api,
      edge: legacy.edge.replace("markiro-edge@", "markiro-platform-edge@"),
      createdAt: legacy.createdAt,
      workflowRunId: legacy.workflowRunId,
    }),
    input.workflowRunId,
  );
}
