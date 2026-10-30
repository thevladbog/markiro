import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
export const COMPATIBLE_PRODUCT_SHA = "6e32b3bf5970ed8793293bcc7e80aef342836e53";
export function assertBootstrapCompatibility(changedPaths) {
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length !== 1 ||
    changedPaths[0] !== "apps/api/src/modules/release-catalog/catalog-bootstrap.ts"
  )
    throw new Error("Bootstrap runtime compatibility rejected.");
}
// PR809 / CI40809831790 artifact12871595527. These exact bytes were reviewed
// and imported in the immutable accepted API image8ec599... with network=none.
// Only these two files are mounted; newer main application/DB outputs are not.
const FROZEN_PAYLOAD = Object.freeze({
  source: [11940, "09285beef68b238fb02e80062949db7156d391ee48f6088b8fdb63a12d3282bd"],
  compiled: [13270, "3c676585271bcd90c49170c7b7c08c862d8191b2701e24c1faa3d93bc523e180"],
  runtime: [6081, "01eaebae491135cc8d2939ee86673b29b1bbbc9158f520a3f1467e0f85c36692"],
});
export function assertBootstrapArtifactCompatibility(changedPaths, payload) {
  const reject = () => {
    throw new Error("Frozen bootstrap payload rejected.");
  };
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length > 10000 ||
    !changedPaths.includes("apps/api/src/modules/release-catalog/catalog-bootstrap.ts") ||
    new Set(changedPaths).size !== changedPaths.length ||
    changedPaths.some(
      (name) =>
        typeof name !== "string" ||
        !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(name) ||
        name.split("/").some((part) => part === "." || part === ".."),
    )
  )
    reject();
  try {
    assertBootstrapCompatibility(changedPaths);
    return;
  } catch {
    // Source-wide admission remains unchanged. Unrelated source drift is safe
    // only if the actual executable overlay is still this frozen reviewed set.
  }
  if (!payload || Object.keys(payload).sort().join(",") !== "compiled,runtime,source") reject();
  for (const [name, [size, sha256]] of Object.entries(FROZEN_PAYLOAD)) {
    const bytes = payload[name];
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== size ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    )
      reject();
  }
}
async function readPayload(root) {
  const [source, compiled, runtime] = await Promise.all([
    readFile(join(root, "apps/api/src/modules/release-catalog/catalog-bootstrap.ts")),
    readFile(join(root, "apps/api/dist/modules/release-catalog/catalog-bootstrap.js")),
    readFile(join(root, "tools/release-catalog/bootstrap-runtime.mjs")),
  ]);
  return { source, compiled, runtime };
}
function compatibility(root, payload) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const sha = git(["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Invalid executor.");
  const paths = git([
    "diff",
    "--name-only",
    COMPATIBLE_PRODUCT_SHA,
    sha,
    "--",
    "apps/api/src",
    "packages",
    "pnpm-lock.yaml",
    "tools/station-release",
    "tools/handheld-release",
    "tools/signer-release",
  ]);
  assertBootstrapArtifactCompatibility(paths.split("\n"), payload);
  return sha;
}
export async function buildReadBootstrapArtifact(root, out) {
  // Keep the same verified buffers through emission; never reread a checked file.
  const payload = await readPayload(root);
  const sha = compatibility(root, payload);
  await mkdir(out, { recursive: false, mode: 0o700 });
  const entries = [
    ["catalog-bootstrap.js", payload.compiled],
    ["bootstrap-runtime.mjs", payload.runtime],
  ];
  const files = [];
  for (const [name, bytes] of entries) {
    await writeFile(join(out, name), bytes, { flag: "wx", mode: 0o400 });
    files.push({
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    });
  }
  await writeFile(
    join(out, "manifest.json"),
    JSON.stringify({
      schema: 1,
      executorSha: sha,
      compatibleProductSha: COMPATIBLE_PRODUCT_SHA,
      files,
    }) + "\n",
    { flag: "wx", mode: 0o400 },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error("Explicit output directory required.");
  if (process.argv[2] === "--applicable") {
    let applicable = false;
    try {
      const root = resolve(process.cwd());
      compatibility(root, await readPayload(root));
      applicable = true;
    } catch {
      /* No artifact can authorize incompatible tooling. */
    }
    process.stdout.write(`applicable=${applicable}\n`);
  } else await buildReadBootstrapArtifact(resolve(process.cwd()), resolve(process.argv[2]));
}
