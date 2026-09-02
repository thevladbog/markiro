import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.argv.length > 2) {
  process.stderr.write("Unknown report argument\n");
  process.exitCode = 1;
} else {
  const manager = process.env.npm_execpath;
  const managerArgs = [
    "--workspace-root",
    "exec",
    "turbo",
    "run",
    "build",
    "--filter=@markiro/api...",
  ];
  const build = manager
    ? spawnSync(process.execPath, [manager, ...managerArgs], {
        stdio: ["inherit", process.stderr, process.stderr],
      })
    : spawnSync("pnpm", managerArgs, { stdio: ["inherit", process.stderr, process.stderr] });
  if (build.status !== 0) {
    process.exitCode = build.status ?? 1;
  } else {
    const cli = fileURLToPath(
      new URL("../dist/cli/report-national-catalog-matrix.js", import.meta.url),
    );
    const result = spawnSync(process.execPath, [cli], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  }
}
