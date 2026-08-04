export const RUNTIME_DEPENDENCY_PROBE_SOURCE = String.raw`
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const forbiddenDependencies = new Set(["@playwright/test", "@opentelemetry/api"]);
// Legacy pnpm deploy leaves this virtual-store self-link dangling after the
// build workspace is omitted from the runtime image. Resolved links are never
// exempt: in-root targets are scanned and external targets fail containment.
const optionalDanglingCentralHoistPackages = new Set(["@markiro/api"]);
const forbiddenDependency = Symbol("forbiddenDependency");
const maximumTasks = 50_000;
const maximumEntries = 100_000;
const maximumManifestBytes = 1_048_576;
const rootArgument = process.argv[1];

let canonicalRoot;
let rootPrefix;
let entryCount = 0;
let taskCount = 0;
const tasks = [];
const visited = new Set();

function enqueue(kind, path, packageName) {
  taskCount += 1;
  if (taskCount > maximumTasks) throw new Error("runtime dependency scan exceeded its task bound");
  tasks.push({ kind, path, packageName });
}

async function canonicalDirectory(path) {
  const canonical = await realpath(path);
  if (canonical !== canonicalRoot && !canonical.startsWith(rootPrefix))
    throw new Error("runtime dependency scan escaped its root");
  const metadata = await stat(canonical);
  if (!metadata.isDirectory()) throw new Error("runtime dependency scan found a non-directory");
  return canonical;
}

async function entries(path) {
  const values = await readdir(path, { withFileTypes: true });
  entryCount += values.length;
  if (entryCount > maximumEntries)
    throw new Error("runtime dependency scan exceeded its entry bound");
  return values;
}

async function enqueueOptionalDirectory(path, kind) {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error("runtime dependency scan found a non-directory");
    enqueue(kind, path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function scanPackage(path) {
  const manifestPath = await realpath(join(path, "package.json"));
  const packagePrefix = path.endsWith(sep) ? path : path + sep;
  if (!manifestPath.startsWith(packagePrefix))
    throw new Error("runtime dependency manifest escaped its package");
  const manifestMetadata = await stat(manifestPath);
  if (!manifestMetadata.isFile())
    throw new Error("runtime dependency manifest is not a regular file");
  if (manifestMetadata.size > maximumManifestBytes)
    throw new Error("runtime dependency manifest exceeded its size bound");
  const manifestBytes = await readFile(manifestPath);
  if (manifestBytes.byteLength > maximumManifestBytes)
    throw new Error("runtime dependency manifest exceeded its size bound");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.name !== "string" ||
    manifest.name.length === 0
  )
    throw new Error("runtime dependency manifest is invalid");
  if (forbiddenDependencies.has(manifest.name)) throw forbiddenDependency;
  await enqueueOptionalDirectory(join(path, "node_modules"), "nodeModules");
}

async function scanTask(task) {
  let path;
  try {
    path = await canonicalDirectory(task.path);
  } catch (error) {
    if (task.kind === "optionalDanglingPackage" && error?.code === "ENOENT") return;
    throw error;
  }
  if (visited.has(path)) return;
  visited.add(path);

  if (task.kind === "package" || task.kind === "optionalDanglingPackage") {
    await scanPackage(path);
    return;
  }
  if (task.kind === "storeEntry") {
    await enqueueOptionalDirectory(join(path, "node_modules"), "nodeModules");
    return;
  }

  for (const entry of await entries(path)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (task.kind === "nodeModules" || task.kind === "centralNodeModules") {
      if (entry.name === ".pnpm") enqueue("store", child);
      else if (entry.name === ".bin" || entry.name.startsWith(".")) continue;
      else if (entry.name.startsWith("@"))
        enqueue(task.kind === "centralNodeModules" ? "centralScope" : "scope", child, entry.name);
      else
        enqueue(
          task.kind === "centralNodeModules" &&
            entry.isSymbolicLink() &&
            optionalDanglingCentralHoistPackages.has(entry.name)
            ? "optionalDanglingPackage"
            : "package",
          child,
        );
    } else if (task.kind === "scope" || task.kind === "centralScope") {
      const packageName = task.packageName + "/" + entry.name;
      if (!entry.name.startsWith("."))
        enqueue(
          task.kind === "centralScope" &&
            entry.isSymbolicLink() &&
            optionalDanglingCentralHoistPackages.has(packageName)
            ? "optionalDanglingPackage"
            : "package",
          child,
        );
    } else if (task.kind === "store") {
      if (entry.name === "node_modules") enqueue("centralNodeModules", child);
      else if (!entry.name.startsWith(".")) enqueue("storeEntry", child);
    }
  }
}

try {
  if (!rootArgument) throw new Error("runtime dependency scan root is required");
  canonicalRoot = await realpath(resolve(rootArgument));
  const rootMetadata = await stat(canonicalRoot);
  if (!rootMetadata.isDirectory()) throw new Error("runtime dependency scan root is invalid");
  rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  enqueue("nodeModules", canonicalRoot);
  while (tasks.length > 0) await scanTask(tasks.pop());
} catch (error) {
  process.exitCode = error === forbiddenDependency ? 1 : 2;
}
`;
