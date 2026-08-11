import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const forwarded = process.argv.slice(2);
const args = forwarded[0] === "--" ? forwarded.slice(1) : forwarded;
if (!safeShape(args)) {
  process.stderr.write("Unknown or forbidden provisioning argument\n");
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
    const cli = fileURLToPath(new URL("../dist/cli/provision-platform-admin.js", import.meta.url));
    const result = spawnSync(process.execPath, [cli, ...forwarded], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  }
}

function safeShape(argv) {
  if (argv.some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    return false;
  }
  return (
    argv.length === 2 && argv[0] === "--email" && Boolean(argv[1]) && !argv[1].startsWith("--")
  );
}
