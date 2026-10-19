import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
test("CI provisions roles via PostgreSQL stdin before migration and cleans up on failure", async (t) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "markiro-ci-provision-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const audit = join(root, "audit.jsonl"),
    docker = join(root, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const audit = ${JSON.stringify(audit)};
const send = value => process.stdout.write(JSON.stringify(value));
if (a[0] === 'context') send([{Endpoints:{docker:{Host:'unix:///synthetic.sock'}}}]);
else if (a[0] === 'info') send([{Name:'compose',Path:${JSON.stringify(docker)}}]);
else {
  const command = a.slice(a.lastIndexOf('-f') + 2);
  const [name] = command;
  const entry = {command, directory: require('node:path').dirname(process.env.MARKIRO_PLATFORM_ENV_FILE)};
  if (name === 'config') {
    const url = file => fs.readFileSync(file, 'utf8').split('\\n').find(x => x.startsWith('DATABASE_URL=')).slice(13);
    send({services:{api:{environment:{SERVER_PROFILE:'platform-only',DATABASE_URL:url(process.env.MARKIRO_PLATFORM_ENV_FILE)}},migrate:{environment:{DATABASE_URL:url(process.env.MARKIRO_PLATFORM_MIGRATION_ENV_FILE)}},edge:{ports:[{host_ip:'127.0.0.1'}]},postgres:{},mailpit:{},seaweedfs:{}}});
  }
  if (name === 'exec' && command.includes('psql')) {
    const input = fs.readFileSync(0, 'utf8');
    entry.sqlViaStdin = input.includes('CREATE ROLE markiro_app') && input.includes('CREATE ROLE markiro_migrator');
    entry.endpoint = process.env.DOCKER_HOST;
    entry.envFileDisabled = process.env.COMPOSE_DISABLE_ENV_FILE;
  }
  fs.appendFileSync(audit, JSON.stringify(entry) + '\\n');
  if (name === 'run') process.exitCode = 1; // Stop after the boundary under test.
}
`,
    { mode: 0o700 },
  );
  const evidence = join(root, "evidence");
  await assert.rejects(
    exec(process.execPath, ["deploy/platform/ci-stack.mjs", "--local-ci"], {
      env: {
        PATH: `${root}:${process.env.PATH}`,
        HOME: root,
        TMPDIR: tmpdir(),
        MARKIRO_SOURCE_SHA: "a".repeat(40),
        PLATFORM_CI_EVIDENCE_DIR: evidence,
      },
      timeout: 30000,
    }),
    (error) => /Platform CI command failed: run --rm/u.test(error.stderr),
  );
  const calls = (await readFile(audit, "utf8")).trim().split("\n").map(JSON.parse);
  const directory = calls[0].directory;
  assert.ok(directory.startsWith(join(await realpath(tmpdir()), "markiro-platform-ci-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(!calls.some(({ command }) => command[0] === "cp" || command.includes("chown")));
  const provisioning = calls.find(({ command }) => command.includes("psql"));
  assert.deepEqual(provisioning.command, [
    "exec",
    "-T",
    "--user",
    "postgres",
    "postgres",
    "psql",
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "markiro",
  ]);
  assert.equal(provisioning.sqlViaStdin, true);
  assert.equal(provisioning.endpoint, "unix:///synthetic.sock");
  assert.equal(provisioning.envFileDisabled, "1");
  assert.ok(calls.indexOf(provisioning) < calls.findIndex(({ command }) => command[0] === "run"));
  assert.equal(calls.at(-1).command[0], "down");
  const result = JSON.parse(await readFile(join(evidence, "verification.json")));
  assert.equal(result.cleanup, true);
  // Harness deliberately retains evidence, but its generated secret files must be gone.
  for (const name of ["runtime.env", "migration.env", "postgres.env", "roles.sql"])
    await assert.rejects(readFile(join(directory, name)), { code: "ENOENT" });
});
