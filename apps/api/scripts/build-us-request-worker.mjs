import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { captureUsRequestBuildDescriptor } from "../dist/deployment/us-request-build-descriptor.js";

try {
  if (process.argv.length !== 2) throw new Error("Invalid arguments");
  // pnpm executes this package script from apps/api; all generated paths are fixed.
  const api = process.cwd();
  const root = resolve(api, "../..");
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  if (git(["rev-parse", "--show-toplevel"]) !== root) throw new Error("Invalid workspace");
  const metadata = JSON.parse(await readFile(join(api, "package.json"), "utf8"));
  if (metadata.name !== "@markiro/api") throw new Error("Invalid package");
  const build = {
    apiVersion: metadata.version,
    gitSha: git(["rev-parse", "HEAD"]),
    dirty: git(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0,
  };
  const document = await captureUsRequestBuildDescriptor(build, {
    trees: {
      api: join(api, "dist"),
      db: join(root, "packages/db/dist"),
      domain: join(root, "packages/domain/dist"),
      contracts: join(root, "packages/platform-contracts/dist"),
    },
    lockfile: join(root, "pnpm-lock.yaml"),
  });
  await writeFile(join(api, "dist/us-request-build.json"), `${JSON.stringify(document)}\n`, {
    flag: "w",
  });
} catch {
  process.stderr.write("us_request_build_invalid\n");
  process.exitCode = 1;
}
