// Explicit local Linux permission regression; never invoked by the default suite.
// Uses only labelled disposable resources, synthetic inputs and an already-local
// Node image. No published ports, database, external network or image pull.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preparedFixture } from "./prepared-target-fixture.mjs";
import { runPostgresProbe } from "../host/probe.mjs";

const docker = process.env.MARKIRO_TEST_DOCKER;
const endpoint = process.env.MARKIRO_TEST_DOCKER_HOST;
assert.ok(docker?.startsWith("/") && endpoint?.startsWith("unix:///"));
const uid = process.getuid(),
  gid = process.getgid();
assert.ok(uid > 0, "Run this regression as a non-root executor");
const label = `io.markiro.probe-permissions=${randomUUID()}`;
const stem = `markiro-probe-permissions-${randomUUID()}`;
const cleanup = [];
const containers = [];
let volumeCreated = false;
const invoke = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      docker,
      ["--host", endpoint, ...args],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(
            Object.assign(new Error("Isolated Linux permission command failed"), {
              stdout,
              stderr,
            }),
          );
        else resolve({ stdout, stderr });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
const inspect = async (kind, name) => JSON.parse((await invoke([kind, "inspect", name])).stdout)[0];

try {
  const image = await inspect("image", "node:24.18.0-bookworm-slim");
  assert.equal(image.Os, "linux");
  const f = await preparedFixture({ after: (fn) => cleanup.push(fn) });
  const workerPath = join(f.root, "worker.mjs");
  await writeFile(
    workerPath,
    await readFile(new URL("./fixtures/host-probe-permissions-worker.mjs", import.meta.url)),
    { mode: 0o600 },
  );
  let create;
  await assert.rejects(
    runPostgresProbe({
      context: { root: f.root, identity: f.identity, configuration: f.expected.configuration },
      policy: { networks: { database: { name: "permission-test", id: "1".repeat(64) } } },
      workerPath,
      verifySources: async () => {},
      command: async (args) => {
        if (args[0] === "create") {
          create = args;
          throw new Error("Captured production argv");
        }
        assert.deepEqual(args, ["container", "ls", "--all", "--format", "{{.Names}}"]);
        return { stdout: "" };
      },
    }),
  );
  assert.ok(create, "Production probe must reach create");
  const files = await Promise.all(
    create
      .flatMap((arg, i) => (arg === "--mount" ? [create[i + 1]] : []))
      .map(async (value) => {
        const mount = Object.fromEntries(value.split(",").map((part) => part.split("=")));
        assert.equal(mount.type, "bind");
        assert.ok(Object.hasOwn(mount, "readonly"));
        return {
          destination: mount.target,
          name: mount.target.split("/").at(-1),
          bytes: (await readFile(mount.source)).toString("base64"),
        };
      }),
  );
  await invoke(["volume", "create", "--label", label, stem]);
  volumeCreated = true;
  const volume = await inspect("volume", stem);
  const setupName = `${stem}-setup`;
  containers.push(setupName);
  await invoke([
    "create",
    "--interactive",
    "--pull=never",
    "--name",
    setupName,
    "--label",
    label,
    "--network",
    "none",
    "--mount",
    `type=volume,source=${stem},target=/data`,
    "--entrypoint",
    "node",
    image.Id,
    "/setup.mjs",
  ]);
  await invoke([
    "cp",
    fileURLToPath(new URL("./fixtures/host-probe-permissions-setup.mjs", import.meta.url)),
    `${setupName}:/setup.mjs`,
  ]);
  await invoke(
    ["start", "--attach", "--interactive", setupName],
    JSON.stringify({ uid, gid, files }),
  );
  const security = create.slice(create.indexOf("--user"), create.indexOf("--mount"));
  assert.ok(
    security.includes("--read-only") &&
      security.includes("ALL") &&
      security.includes("no-new-privileges:true"),
  );
  const run = async (name, user) => {
    const flags = [...security];
    flags[flags.indexOf("--user") + 1] = user;
    containers.push(name);
    return invoke([
      "run",
      "--rm",
      "--pull=never",
      "--name",
      name,
      "--label",
      label,
      "--network",
      "none",
      ...flags,
      ...files.flatMap((file) => [
        "--mount",
        `type=bind,source=${volume.Mountpoint}/${file.name},target=${file.destination},readonly`,
      ]),
      image.Id,
      "/probe/worker.mjs",
    ]);
  };
  // Negative controls exercise actual Linux DAC with every capability dropped.
  for (const [suffix, user] of [
    ["root", "0:0"],
    ["foreign", `${uid + 1}:${gid}`],
  ]) {
    await assert.rejects(run(`${stem}-${suffix}`, user), (error) =>
      error.stderr.includes("EACCES"),
    );
  }
  const actualUser = security[security.indexOf("--user") + 1];
  const result = await run(`${stem}-executor`, actualUser);
  assert.deepEqual(JSON.parse(result.stdout), { read: 3, uid });
  console.log(
    JSON.stringify({
      status: "passed",
      platform: `${image.Os}/${image.Architecture}`,
      imageId: image.Id,
      executor: actualUser,
      privateFiles: 3,
      negativeControls: ["root without capabilities", "foreign UID"],
      network: "none",
    }),
  );
} finally {
  for (const name of containers) {
    const names = (
      await invoke([
        "container",
        "ls",
        "--all",
        "--filter",
        `label=${label}`,
        "--format",
        "{{.Names}}",
      ])
    ).stdout
      .trim()
      .split("\n");
    if (names.includes(name)) {
      const c = await inspect("container", name);
      assert.equal(c.Config.Labels[label.split("=")[0]], label.split("=")[1]);
      await invoke(["container", "rm", "--force", c.Id]);
    }
  }
  if (volumeCreated) {
    const volume = await inspect("volume", stem);
    assert.equal(volume.Labels[label.split("=")[0]], label.split("=")[1]);
    await invoke(["volume", "rm", stem]);
  }
  assert.equal(
    (
      await invoke([
        "container",
        "ls",
        "--all",
        "--filter",
        `label=${label}`,
        "--format",
        "{{.Names}}",
      ])
    ).stdout.trim(),
    "",
  );
  assert.equal(
    (
      await invoke(["volume", "ls", "--filter", `label=${label}`, "--format", "{{.Name}}"])
    ).stdout.trim(),
    "",
  );
  for (const fn of cleanup.reverse()) await fn();
}
