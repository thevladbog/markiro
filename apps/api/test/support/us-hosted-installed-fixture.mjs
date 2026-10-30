import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

// Test-only fixed installed topology. No host mounts, ports, network, pull or runtime seam.
const name = `us-hosted-installed-${randomUUID()}`;
let id;
let created = 0;
let removed = 0;
const docker = (args, input) =>
  execFileSync("docker", args, {
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
function removeOwned(container) {
  const owner = docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "us-fixture-owner"}}',
    container,
  ]).trim();
  if (owner !== name) throw new Error("fixture ownership mismatch");
  docker(["stop", "--time", "2", container]);
  docker(["rm", container]);
  const remaining = docker([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    "id=" + container,
    "--format",
    "{{.ID}}",
  ]);
  if (remaining.trim()) throw new Error("fixture remains");
}
try {
  const input = readFileSync(0, "utf8");
  if (Buffer.byteLength(input) > 1024 * 1024) throw new Error();
  const spec = JSON.parse(input);
  if (
    typeof spec.moduleSource !== "string" ||
    typeof spec.setup !== "string" ||
    typeof spec.exercise !== "string"
  )
    throw new Error();
  id = docker([
    "create",
    "--pull=never",
    "--name",
    name,
    "--label",
    `us-fixture-owner=${name}`,
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/app:rw,nosuid,nodev,noexec,mode=0755",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,mode=0700",
    "--user",
    "0:0",
    "node:24.21.0-bookworm-slim",
    "node",
    "-e",
    "setInterval(() => {}, 1000)",
  ]).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error();
  created = 1;
  docker(["start", id]);
  const prepare = `const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));fs.mkdirSync('/app/apps/api/dist',{recursive:true});fs.writeFileSync('/app/apps/api/dist/reader.cjs',x.moduleSource,{mode:0o444});(new Function('require',x.setup))(require);`;
  docker(["exec", "-i", "--user", "0:0", id, "node", "-e", prepare], JSON.stringify(spec));
  const output = docker(["exec", "-i", "--user", "10001:10001", id, "node"], spec.exercise);
  const result = JSON.parse(output);
  if (
    !Array.isArray(result) ||
    result.some((value) => typeof value !== "number" || !Number.isSafeInteger(value))
  )
    throw new Error();
  removeOwned(id);
  removed = 1;
  process.stdout.write(`${JSON.stringify({ result, created, removed })}\n`);
} catch {
  process.stderr.write("us_hosted_installed_fixture_failed\n");
  process.exitCode = 1;
} finally {
  if (created && !removed && id) {
    try {
      removeOwned(id);
      removed = 1;
    } catch {
      process.stderr.write("us_hosted_installed_fixture_cleanup_failed\n");
      process.exitCode = 1;
    }
  }
}
