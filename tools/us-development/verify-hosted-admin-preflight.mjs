import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAdministrativePackageLocator,
  prepareAdministrativeTopology,
  closeAdministrativeTopology,
  inspectAdministrativeTopology,
  prepareAdministrativeRegressionTopology,
  closeAdministrativeRegressionTopology,
  inspectAdministrativeRegressionTopology,
  assertAdministrativeNativeReport,
} from "../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const refused = () => new Error("us_hosted_admin_preflight_refused");
async function readFixed(path, limit) {
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.uid !== BigInt(process.getuid()) ||
    before.size > BigInt(limit) ||
    (before.mode & 0o022n) !== 0n
  )
    throw refused();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = await file.readFile(),
      after = await file.stat({ bigint: true }),
      last = await lstat(path, { bigint: true });
    if (
      bytes.length !== Number(before.size) ||
      ["dev", "ino", "size", "mode", "uid", "gid", "mtimeNs", "ctimeNs"].some(
        (key) => before[key] !== after[key] || before[key] !== last[key],
      )
    )
      throw refused();
    return bytes;
  } finally {
    await file.close();
  }
}
async function absent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw refused();
  }
  throw refused();
}

async function main() {
  if (
    process.argv.length !== 2 ||
    Number(process.versions.node.split(".")[0]) < 24 ||
    Object.keys(process.env).some((name) => name.startsWith("US_HOSTED_TEST_"))
  )
    throw refused();
  for (const base of [root, resolve(root, "apps/api")])
    for (const name of [".env", ".env.local", ".env.test", ".env.test.local"])
      await absent(resolve(base, name));
  const locatorPath = resolve(
    root,
    ".superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/admin-preflight-package.json",
  );
  const locator = parseAdministrativePackageLocator(
    (await readFixed(locatorPath, 16384)).toString("utf8"),
    root,
  );
  const directory = resolve(dirname(locator.source), "admin-preflight-acceptance");
  await mkdir(directory, { mode: 0o700 });
  let nativeOwner,
    regressionOwner,
    terminatedClient = false;
  const state = {
    schemaVersion: 1,
    purpose: "synthetic-test-only",
    fixtureSha: locator.fixtureSha,
    phase: "starting",
    runs: [],
    deploymentReady: false,
    releaseEnabled: false,
  };
  const persist = async () => {
    const path = resolve(directory, "progress.json"),
      temporary = resolve(directory, "progress.next.json");
    await writeFile(temporary, JSON.stringify(state) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  };
  const nativePersist = async (snapshot) => {
    state.native = snapshot;
    await persist();
  };
  const regressionPersist = async (snapshot) => {
    state.regression = snapshot;
    await persist();
  };
  const run = async (mode) => {
    state.phase = mode;
    await persist();
    const reportPath = resolve(directory, mode + ".json"),
      logPath = resolve(directory, mode + ".log");
    await absent(reportPath);
    await absent(logPath);
    const environment = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      COREPACK_ENABLE_NETWORK: "0",
      NO_COLOR: "1",
    };
    if (process.env.COREPACK_HOME !== undefined)
      environment.COREPACK_HOME = process.env.COREPACK_HOME;
    const args = [
      "pnpm",
      "--filter",
      "@markiro/api",
      "exec",
      "vitest",
      "run",
      mode === "regression-green"
        ? "test/us-hosted-installed-entry.e2e.test.ts"
        : "test/us-hosted-admin-preflight-installed.e2e.test.ts",
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
      "--outputFile",
      reportPath,
    ];
    if (mode === "ca-red" || mode === "name-red") {
      environment[
        mode === "ca-red" ? "US_HOSTED_TEST_ADMIN_CA_MUTANT" : "US_HOSTED_TEST_ADMIN_NAME_MUTANT"
      ] = "1";
      args.push(
        "-t",
        "refuses the actual " + (mode === "ca-red" ? "wrongCA" : "wrongName") + " database peer",
      );
    }
    const result = await new Promise((resolveCommand) => {
      execFile(
        "corepack",
        args,
        {
          cwd: root,
          env: environment,
          encoding: "utf8",
          timeout:
            mode === "ca-red" || mode === "name-red"
              ? 30000
              : mode === "regression-green"
                ? 180000
                : 120000,
          maxBuffer: 16 * 1024 * 1024,
          shell: false,
        },
        (error, stdout, stderr) => resolveCommand({ error, stdout, stderr }),
      );
    });
    await writeFile(logPath, result.stdout + result.stderr, { flag: "wx", mode: 0o600 });
    if (
      result.error &&
      (result.error.killed || result.error.signal || typeof result.error.code !== "number")
    ) {
      terminatedClient = true;
      throw refused();
    }
    const exit = result.error ? result.error.code : 0;
    const report = JSON.parse((await readFixed(reportPath, 16 * 1024 * 1024)).toString("utf8"));
    state.runs.push(assertAdministrativeNativeReport(report, mode, exit));
    await persist();
  };
  try {
    state.phase = "native_preparation";
    await persist();
    nativeOwner = await prepareAdministrativeTopology(locator, root, nativePersist);
    if (inspectAdministrativeTopology(nativeOwner).protocolOnly) throw refused();
    await run("native-green");
    await run("ca-red");
    await run("name-red");
    await run("native-green-restored");
    state.phase = "native_normal_close";
    await persist();
    state.nativeClosure = await closeAdministrativeTopology(nativeOwner, nativePersist);
    state.phase = "original_regression_preparation";
    await persist();
    regressionOwner = await prepareAdministrativeRegressionTopology(nativeOwner, regressionPersist);
    await run("regression-green");
    state.regressionClosure = await closeAdministrativeRegressionTopology(
      regressionOwner,
      regressionPersist,
    );
    state.phase = "completed";
    await persist();
    await writeFile(resolve(directory, "result.json"), JSON.stringify(state) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(
      JSON.stringify({
        nativeTests: 19,
        restoredTests: 19,
        intendedMutants: 2,
        originalRegressionTests: 33,
        normalClosure: true,
        deploymentReady: false,
        releaseEnabled: false,
      }) + "\n",
    );
  } catch (error) {
    if (error?.topologyOwner) nativeOwner = error.topologyOwner;
    if (error?.regressionOwner) regressionOwner = error.regressionOwner;
    state.failurePhase = state.phase;
    state.phase = "failed";
    if (nativeOwner) state.native = inspectAdministrativeTopology(nativeOwner);
    if (regressionOwner)
      state.regression = inspectAdministrativeRegressionTopology(regressionOwner);
    if (!terminatedClient) {
      try {
        if (regressionOwner && state.regression?.phase === "regression_prepared_for_actual_tests")
          state.failureCleanup = await closeAdministrativeRegressionTopology(
            regressionOwner,
            regressionPersist,
          );
        else if (nativeOwner && state.native?.phase === "prepared_for_actual_tests")
          state.failureCleanup = await closeAdministrativeTopology(nativeOwner, nativePersist);
      } catch {
        state.failureCleanupIncomplete = true;
      }
    }
    await persist();
    throw refused();
  }
}
main().catch(() => {
  process.stderr.write("us_hosted_admin_preflight_refused\n");
  process.exitCode = 1;
});
