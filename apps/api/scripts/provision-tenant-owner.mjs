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
    const cli = fileURLToPath(new URL("../dist/cli/provision-tenant-owner.js", import.meta.url));
    const result = spawnSync(process.execPath, [cli, ...forwarded], { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
  }
}

function safeShape(argv) {
  if (argv.some((argument) => argument === "--password" || argument.startsWith("--password="))) {
    return false;
  }
  const renewals = argv.filter((argument) => argument === "--renew-activation").length;
  if (renewals > 1) return false;
  const unmanaged = argv.filter((argument) => argument === "--allow-unmanaged-without-demo").length;
  if (unmanaged > 1) return false;
  const values = argv.filter(
    (argument) =>
      argument !== "--renew-activation" && argument !== "--allow-unmanaged-without-demo",
  );
  if (values.length % 2 !== 0) return false;
  const allowed = new Set(["--email", "--tenant-name", "--tenant-slug"]);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || seen.has(flag) || !value || value.startsWith("--")) return false;
    seen.add(flag);
  }
  return true;
}
