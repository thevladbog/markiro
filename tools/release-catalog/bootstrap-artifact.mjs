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
function compatibility(root) {
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
  assertBootstrapCompatibility(paths.split("\n"));
  return sha;
}
export async function buildReadBootstrapArtifact(root, out) {
  const sha = compatibility(root);
  await mkdir(out, { recursive: false, mode: 0o700 });
  const entries = [
    ["catalog-bootstrap.js", "apps/api/dist/modules/release-catalog/catalog-bootstrap.js"],
    ["bootstrap-runtime.mjs", "tools/release-catalog/bootstrap-runtime.mjs"],
  ];
  const files = [];
  for (const [name, source] of entries) {
    const bytes = await readFile(join(root, source));
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
      compatibility(resolve(process.cwd()));
      applicable = true;
    } catch {
      /* No artifact can authorize incompatible tooling. */
    }
    process.stdout.write(`applicable=${applicable}\n`);
  } else await buildReadBootstrapArtifact(resolve(process.cwd()), resolve(process.argv[2]));
}
