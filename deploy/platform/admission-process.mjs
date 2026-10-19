import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export function childEnvironment() {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}
export async function runCommand(command, args, options) {
  try {
    return (await exec(command, args, options)).stdout;
  } catch {
    throw new Error("admission command failed");
  }
}
