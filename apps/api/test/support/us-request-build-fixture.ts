import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { UsRequestBuildRoots } from "../../src/deployment/us-request-build-descriptor";

export const localBuildEnv = async () =>
  parseEnv(await readFile("../../deploy/us-development/local.env.example", "utf8"));

export async function createUsRequestBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), "us-request-build-"));
  try {
    const api = join(root, "apps/api");
    const roots: UsRequestBuildRoots = {
      trees: {
        api: join(api, "dist"),
        db: join(root, "packages/db/dist"),
        domain: join(root, "packages/domain/dist"),
        contracts: join(root, "packages/platform-contracts/dist"),
      },
      lockfile: join(root, "pnpm-lock.yaml"),
    };
    const cleanBuild = { apiVersion: "fixture-1", gitSha: "a".repeat(40), dirty: false };
    await writeFile(roots.lockfile, "fixture lock\n");
    await writeFile(
      join(root, ".gitignore"),
      "apps/api/dist/us-request-build.json\nnode_modules/\n",
    );
    for (const path of Object.values(roots.trees)) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "index.js"), "fixture output\n");
    }
    const workspacePackages = {
      "@markiro/db": "db",
      "@markiro/domain": "domain",
      "@markiro/platform-contracts": "contracts",
    } as const;
    await mkdir(join(root, "node_modules/@markiro"), { recursive: true });
    for (const [name, tree] of Object.entries(workspacePackages)) {
      const directory = join(roots.trees[tree], "..");
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name,
          exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
        }),
      );
      await symlink(directory, join(root, "node_modules", name), "dir");
    }
    await writeFile(
      join(api, "package.json"),
      JSON.stringify({ name: "@markiro/api", version: "fixture-1" }),
    );
    await writeFile(join(roots.trees.api, "main.us-request-worker.js"), "fixture worker\n");
    const fonts = join(roots.trees.api, "modules/traceability/plans/assets");
    await mkdir(fonts, { recursive: true });
    await writeFile(join(fonts, "IBMPlexSans-Regular.ttf"), "regular font\n");
    await writeFile(join(fonts, "IBMPlexSans-Bold.ttf"), "bold font\n");
    const libraryVersions = {
      "@react-pdf/renderer": "4.6.1",
      "write-excel-file": "4.1.1",
      fflate: "0.8.3",
    };
    for (const [name, version] of Object.entries(libraryVersions)) {
      const directory = join(api, "node_modules", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name,
          version,
          main: "index.js",
          ...(name === "write-excel-file" ? { exports: { "./node": "./index.js" } } : {}),
        }),
      );
      await writeFile(join(directory, "index.js"), "module.exports = {};\n");
    }
    const descriptorPath = join(roots.trees.api, "us-request-build.json");
    return {
      root,
      api,
      roots,
      cleanBuild,
      descriptorPath,
      writeDocument: (document: unknown) => writeFile(descriptorPath, JSON.stringify(document)),
      replaceApiBytes: (path: string, bytes: Buffer) =>
        writeFile(join(roots.trees.api, path), bytes),
      setLibraryVersion: (name: string, version: string) =>
        writeFile(
          join(api, "node_modules", name, "package.json"),
          JSON.stringify({
            name,
            version,
            main: "index.js",
            ...(name === "write-excel-file" ? { exports: { "./node": "./index.js" } } : {}),
          }),
        ),
      initializeGit: () => {
        const git = (args: string[]) =>
          execFileSync("git", args, {
            cwd: root,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_SYSTEM: "/dev/null",
              GIT_AUTHOR_NAME: "Build Fixture",
              GIT_AUTHOR_EMAIL: "fixture@example.test",
              GIT_COMMITTER_NAME: "Build Fixture",
              GIT_COMMITTER_EMAIL: "fixture@example.test",
            },
          });
        git(["init", "--quiet"]);
        git(["add", "apps", "packages", "pnpm-lock.yaml", ".gitignore"]);
        git(["commit", "--quiet", "-m", "Owned synthetic build fixture"]);
        return git(["rev-parse", "HEAD"]).trim();
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
