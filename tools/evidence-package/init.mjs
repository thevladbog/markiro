import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EvidencePackageError, MAX_MANIFEST_BYTES } from "./evidence-package.mjs";

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

function invalid(message, options) {
  throw new EvidencePackageError(message, options);
}

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

async function probe(root, relativePath) {
  const segments = relativePath.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let information;
    try {
      information = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, path: current };
      throw error;
    }
    if (information.isSymbolicLink()) invalid(`symlink is not allowed: ${relativePath}`);
    if (index < segments.length - 1 && !information.isDirectory()) {
      invalid(`scaffold parent is not a directory: ${relativePath}`);
    }
    if (index === segments.length - 1) return { exists: true, information, path: current };
  }
  invalid("invalid scaffold path");
}

async function ensureDirectory(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    try {
      const information = await lstat(current);
      if (information.isSymbolicLink()) invalid(`symlink is not allowed: ${relativePath}`);
      if (!information.isDirectory()) invalid(`scaffold path is not a directory: ${relativePath}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        invalid(`scaffold path is not a directory: ${relativePath}`);
      }
    }
  }
}

async function createMissingFile(target, contents) {
  let handle;
  try {
    handle = await open(target, "wx", 0o600);
    if (contents.length > 0) await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function validateExistingManifest(root, operationId) {
  const existing = await probe(root, MANIFEST_PATH);
  if (!existing.exists) return;
  if (!existing.information.isFile()) invalid("existing manifest.json is not a regular file");
  if (existing.information.size > MAX_MANIFEST_BYTES) invalid("manifest size limit exceeded");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(existing.path, "utf8"));
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
}

async function resolveInitializationRoot(root) {
  if (typeof root !== "string" || root.length === 0) invalid("evidence root is required");
  const absolute = resolve(root);
  try {
    const information = await lstat(absolute);
    if (information.isSymbolicLink()) invalid("evidence root must not be a symlink");
    if (!information.isDirectory()) invalid("evidence root must be a directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const information = await lstat(absolute);
    if (information.isSymbolicLink() || !information.isDirectory()) {
      invalid("evidence root must be a directory");
    }
  }
  return realpath(absolute);
}

export async function initializeEvidencePackage(root, operationId) {
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) {
    invalid("invalid operation id; expected INV-YYYYMMDD-name-NN");
  }
  const resolvedRoot = await resolveInitializationRoot(root);

  for (const relativePath of DIRECTORIES) {
    const existing = await probe(resolvedRoot, relativePath);
    if (existing.exists && !existing.information.isDirectory()) {
      invalid(`scaffold path is not a directory: ${relativePath}`);
    }
  }
  const baseline = await probe(resolvedRoot, BASELINE_PATH);
  if (baseline.exists) {
    if (!baseline.information.isFile()) invalid("raw baseline is not a regular file");
    if (baseline.information.size !== 0) invalid("raw baseline is not empty; init refused");
  }
  await validateExistingManifest(resolvedRoot, operationId);

  for (const relativePath of DIRECTORIES) await ensureDirectory(resolvedRoot, relativePath);
  await createMissingFile(join(resolvedRoot, BASELINE_PATH), "");
  const manifestText = `${JSON.stringify(initialManifest(operationId), null, 2)}\n`;
  await createMissingFile(join(resolvedRoot, MANIFEST_PATH), manifestText);

  return { operationId, root: resolvedRoot };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (args.length !== 2) invalid("usage: evidence:init <root> <operation-id>");
  const result = await initializeEvidencePackage(args[0], args[1]);
  process.stdout.write(`Initialized evidence package ${result.operationId} at ${result.root}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected failure";
    process.stderr.write(`evidence:init: ${message}\n`);
    process.exitCode = 1;
  }
}
