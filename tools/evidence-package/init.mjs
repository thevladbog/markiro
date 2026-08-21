import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.mjs";
import { MAX_MANIFEST_BYTES } from "./evidence-package.mjs";
import {
  assertEvidenceRootStable,
  bindEvidenceRoot,
  closeEvidenceRoot,
  ensureBoundDirectory,
  EvidencePackageError,
  installBoundFileIfMissing,
  invalid,
  lstatBoundPath,
  readBoundRegularFile,
} from "./secure-filesystem.mjs";

const OPERATION_ID = /^INV-\d{8}-[a-z0-9-]{2,40}-\d{2}$/;
const DIRECTORIES = [
  "baseline",
  "amendments",
  "photos",
  "photos/duplicates",
  "exports",
  "exports/system",
  "metrics",
  "attestation",
];
const BASELINE_PATH = "baseline/old-sscc.raw.txt";
const MANIFEST_PATH = "manifest.json";

function initialManifest(operationId) {
  return {
    manifestVersion: 1,
    operationId,
    protocolVersion: "inventory-recovery-v1",
    customer: { legalName: "", site: "" },
    operator: { name: "", role: "founder" },
    device: { id: "", stationVersion: "", apiVersion: "" },
    timezone: "Europe/Moscow",
    newSscc: { threshold: "", range: "" },
    scorecardEligibility: {
      eligible: false,
      reason: "founder_led_inventory_recovery",
    },
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    artifacts: [],
  };
}

async function existingInformation(session, relativePath) {
  try {
    return await lstatBoundPath(session, relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function validateBaseline(session) {
  const information = await existingInformation(session, BASELINE_PATH);
  if (!information) return false;
  if (!information.isFile()) invalid("raw baseline is not a regular file");
  try {
    await readBoundRegularFile(session, BASELINE_PATH, {
      expected: information,
      maxBytes: 0,
    });
  } catch (error) {
    if (error instanceof EvidencePackageError && error.message === "file size limit exceeded") {
      invalid("raw baseline is not empty; init refused", { cause: error });
    }
    throw error;
  }
  return true;
}

async function validateManifest(session, operationId) {
  const information = await existingInformation(session, MANIFEST_PATH);
  if (!information) return false;
  if (!information.isFile()) invalid("existing manifest.json is not a regular file");
  let bytes;
  try {
    ({ bytes } = await readBoundRegularFile(session, MANIFEST_PATH, {
      expected: information,
      maxBytes: MAX_MANIFEST_BYTES,
    }));
  } catch (error) {
    if (error instanceof EvidencePackageError && error.message === "file size limit exceeded") {
      invalid("manifest size limit exceeded", { cause: error });
    }
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    invalid("existing manifest.json is not valid JSON", { cause: error });
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.operationId !== operationId
  ) {
    invalid("existing manifest.json belongs to a different operation");
  }
  return true;
}

export async function initializeEvidencePackage(root, operationId, options = {}) {
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
    invalid("invalid operation id; expected INV-YYYYMMDD-name-NN");
  }

  const session = await bindEvidenceRoot(root, options, { create: true });
  let result;
  let operationFailed = false;
  let operationError;
  try {
    // Refuse populated source data before creating any scaffold entries.
    await validateBaseline(session);
    await validateManifest(session, operationId);
    for (const relativePath of DIRECTORIES) {
      const information = await existingInformation(session, relativePath);
      if (information && !information.isDirectory()) {
        invalid(`scaffold path is not a directory: ${relativePath}`);
      }
    }

    for (const relativePath of DIRECTORIES) {
      await ensureBoundDirectory(session, relativePath);
    }

    await installBoundFileIfMissing(session, BASELINE_PATH, Buffer.alloc(0), async () => {
      await validateBaseline(session);
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(initialManifest(operationId), null, 2)}\n`);
    await installBoundFileIfMissing(session, MANIFEST_PATH, manifestBytes, async () => {
      await validateManifest(session, operationId);
    });

    // Creation and EEXIST paths converge on the same final validation.
    await validateBaseline(session);
    await validateManifest(session, operationId);
    await assertEvidenceRootStable(session);
    result = { operationId, root: session.rootPath };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await closeEvidenceRoot(session);
  } catch (closeError) {
    // Cleanup must remain observable after success, but must not replace the
    // primary validation or scaffold failure.
    if (!operationFailed) throw closeError;
  }
  if (operationFailed) throw operationError;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli({
    action: ([root, operationId]) => initializeEvidencePackage(root, operationId),
    args: process.argv.slice(2),
    command: "evidence:init",
    expectedArgs: 2,
    formatSuccess: (result) =>
      `Initialized evidence package ${result.operationId} at ${result.root}\n`,
    usage: "usage: evidence:init <root> <operation-id>",
  });
}
