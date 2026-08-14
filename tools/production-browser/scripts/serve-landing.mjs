import { execFileSync, spawn } from "node:child_process";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "../../../apps/landing");
const astro = path.join(appRoot, "node_modules/.bin/astro");
const environment = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" };

execFileSync(astro, ["build"], { cwd: appRoot, env: environment, stdio: "inherit" });
const preview = spawn(astro, ["preview", "--host", "127.0.0.1", "--port", "5473"], {
  cwd: appRoot,
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => preview.kill(signal));
}
preview.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
