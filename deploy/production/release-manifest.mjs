import { link, open, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";

const API_REPOSITORY = "ghcr.io/thevladbog/markiro-api";
const EDGE_REPOSITORY = "ghcr.io/thevladbog/markiro-edge";
const INPUT_KEYS = ["apiDigest", "createdAt", "edgeDigest", "releaseSha", "workflowRunId"];
const MANIFEST_KEYS = ["api", "commit", "createdAt", "edge", "workflowRunId"];
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string" || !UTC_TIMESTAMP.test(value)) return false;
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}

function releaseManifestError() {
  throw new Error("invalid release manifest");
}

function validateManifest(value, expectedRunId) {
  if (!hasExactKeys(value, MANIFEST_KEYS)) releaseManifestError();
  if (typeof expectedRunId !== "string" || !RUN_ID.test(expectedRunId)) releaseManifestError();
  if (
    typeof value.commit !== "string" ||
    !SHA.test(value.commit) ||
    typeof value.api !== "string" ||
    typeof value.edge !== "string" ||
    typeof value.workflowRunId !== "string" ||
    !RUN_ID.test(value.workflowRunId) ||
    value.workflowRunId !== expectedRunId ||
    !isCanonicalTimestamp(value.createdAt)
  )
    releaseManifestError();

  const api = `${API_REPOSITORY}@`;
  const edge = `${EDGE_REPOSITORY}@`;
  if (
    !value.api.startsWith(api) ||
    !DIGEST.test(value.api.slice(api.length)) ||
    !value.edge.startsWith(edge) ||
    !DIGEST.test(value.edge.slice(edge.length))
  )
    releaseManifestError();

  return value;
}

export function createReleaseManifest(input) {
  if (!hasExactKeys(input, INPUT_KEYS)) releaseManifestError();
  if (
    typeof input.releaseSha !== "string" ||
    !SHA.test(input.releaseSha) ||
    typeof input.apiDigest !== "string" ||
    !DIGEST.test(input.apiDigest) ||
    typeof input.edgeDigest !== "string" ||
    !DIGEST.test(input.edgeDigest) ||
    typeof input.workflowRunId !== "string" ||
    !RUN_ID.test(input.workflowRunId) ||
    !isCanonicalTimestamp(input.createdAt)
  )
    releaseManifestError();

  return validateManifest(
    {
      commit: input.releaseSha,
      api: `${API_REPOSITORY}@${input.apiDigest}`,
      edge: `${EDGE_REPOSITORY}@${input.edgeDigest}`,
      workflowRunId: input.workflowRunId,
      createdAt: input.createdAt,
    },
    input.workflowRunId,
  );
}

export function parseReleaseManifest(text, expectedRunId) {
  if (typeof text !== "string") releaseManifestError();
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    releaseManifestError();
  }
  return validateManifest(manifest, expectedRunId);
}

async function createFileAtomically(outputPath, content) {
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}`,
  );
  let temporaryFile;
  try {
    temporaryFile = await open(temporaryPath, "wx", 0o600);
    await temporaryFile.writeFile(content, "utf8");
    await temporaryFile.sync();
    await temporaryFile.close();
    temporaryFile = undefined;
    await link(temporaryPath, outputPath);
    await unlink(temporaryPath);
  } catch {
    await temporaryFile?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("invalid release manifest command");
  }
}

async function runCli(arguments_) {
  const [command, filePath, expectedRunId] = arguments_;
  if (command === "create" && typeof filePath === "string" && expectedRunId === undefined) {
    const manifest = createReleaseManifest({
      releaseSha: process.env.RELEASE_SHA,
      apiDigest: process.env.API_DIGEST,
      edgeDigest: process.env.EDGE_DIGEST,
      workflowRunId: process.env.GITHUB_RUN_ID,
      createdAt: process.env.CREATED_AT,
    });
    await createFileAtomically(filePath, JSON.stringify(manifest));
    process.stdout.write("release manifest created\n");
    return;
  }
  if (
    command === "validate" &&
    typeof filePath === "string" &&
    typeof expectedRunId === "string" &&
    arguments_.length === 3
  ) {
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      releaseManifestError();
    }
    const manifest = parseReleaseManifest(text, expectedRunId);
    process.stdout.write(`${manifest.commit}\n${manifest.api}\n${manifest.edge}\n`);
    return;
  }
  throw new Error("invalid release manifest command");
}

if (isMainModule(import.meta.url))
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error.message === "invalid release manifest" ? error.message : "invalid release manifest command"}\n`,
    );
    process.exitCode = 1;
  });
