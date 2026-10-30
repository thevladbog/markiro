import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensure } from "./backup/schemas.mjs";
import { recoverySshArguments } from "./recovery-transport.mjs";
import {
  assertNoCatalogPeers,
  validateUpgradeDispatch,
  verifyConfigurationDispatch,
} from "./upgrade-dispatch.mjs";
import { REPOSITORY, githubTransport } from "./admission-github.mjs";
import { fetchPlatformCi } from "./release-ci.mjs";
import { writePrivateFile } from "./host/files.mjs";
import { runHostProcess } from "./host/process.mjs";

const ENTRY = "deploy/platform/host/dadata-host.mjs";
const LIMIT = 1048576;
const SOURCE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.mjs$/u;
const CLEAN_ENV = Object.freeze({ PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C" });
const FAILURE =
  "DaData configuration failed; preserve evidence and reconcile before any new operation.\n";

/** Reviewed checkout only. Runtime hooks independently deny imports outside this exact closure. */
export async function sourceClosure(root, entry = ENTRY) {
  ensure(typeof root === "string" && SOURCE_PATH.test(entry));
  const base = await realpath(root);
  const files = new Map();
  async function visit(path) {
    ensure(SOURCE_PATH.test(path) && files.size < 256);
    if (files.has(path)) return;
    const absolute = join(base, path);
    ensure((await realpath(absolute)) === absolute);
    const info = await lstat(absolute);
    ensure(info.isFile() && info.nlink === 1 && info.size <= LIMIT);
    const bytes = await readFile(absolute);
    ensure(bytes.length <= LIMIT);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    files.set(path, createHash("sha256").update(bytes).digest("hex"));
    // Only literal dynamic imports can be included in an immutable source closure.
    ensure(!/\bimport\s*\(\s*(?!["'])[^\s]/u.test(text));
    const imports = [
      ...text.matchAll(/\bfrom\s*["']([^"']+)["']/gu),
      ...text.matchAll(/\bimport\s*["']([^"']+)["']/gu),
      ...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu),
    ];
    for (const match of imports) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      ensure(/^\.{1,2}\//u.test(specifier));
      const dependency = posix.normalize(posix.join(posix.dirname(path), specifier));
      ensure(SOURCE_PATH.test(dependency) && !dependency.startsWith("../"));
      await visit(dependency);
    }
  }
  await visit(entry);
  return [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, sha256]) => ({ path, sha256 }));
}

// Self-contained bootstrap: before source verification only Node builtins execute.
// No installed project module is trusted to verify itself or another installed module.
async function configurationLoader() {
  try {
    const fs = await import("node:fs");
    const crypto = await import("node:crypto");
    const path = await import("node:path");
    const url = await import("node:url");
    const { registerHooks, isBuiltin } = await import("node:module");
    const check = (condition) => {
      if (!condition) throw Error();
    };
    const limit = 1048576;
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      check(size <= limit);
      chunks.push(chunk);
    }
    const input = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    check(
      Object.keys(input).sort().join(",") ===
        "actorLogin,dispatch,executorCiRunAttempt,executorCiRunId,operationId,planSha256,sourceFiles,token",
    );
    const { dispatch, sourceFiles } = input;
    check(dispatch && Object.keys(dispatch).sort().join(",") === "runAttempt,runId,toolingSha");
    check(
      /^[a-f0-9]{40}$/u.test(dispatch.toolingSha) &&
        /^[1-9][0-9]{0,19}$/u.test(dispatch.runId) &&
        dispatch.runAttempt === "1",
    );
    check(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        input.operationId,
      ),
    );
    check(
      /^[a-f0-9]{64}$/u.test(input.planSha256) &&
        /^[1-9][0-9]{0,19}$/u.test(input.executorCiRunId) &&
        input.executorCiRunAttempt === "1",
    );
    check(
      typeof input.token === "string" &&
        input.token.length > 0 &&
        input.token.length <= 16384 &&
        !/\s/u.test(input.token),
    );
    check(
      typeof input.actorLogin === "string" &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(input.actorLogin),
    );
    const base = "/opt/markiro-platform/configuration-executors";
    const root = `${base}/${dispatch.toolingSha}`;
    const entry = "deploy/platform/host/dadata-host.mjs";
    const sources = new Map();
    check(Array.isArray(sourceFiles) && sourceFiles.length > 0 && sourceFiles.length <= 256);
    for (const file of sourceFiles) {
      check(file && Object.keys(file).sort().join(",") === "path,sha256");
      check(
        typeof file.path === "string" &&
          /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*\.mjs$/u.test(file.path),
      );
      check(
        typeof file.sha256 === "string" &&
          /^[a-f0-9]{64}$/u.test(file.sha256) &&
          !sources.has(file.path),
      );
      sources.set(file.path, file.sha256);
    }
    check(sources.has(entry));
    const directories = (directory) => {
      let current = "/";
      for (const part of ["", ...directory.slice(1).split("/")]) {
        if (part) current = path.join(current, part);
        const info = fs.lstatSync(current);
        const privateDirectory = current === base || current.startsWith(`${base}/`);
        const sticky = !privateDirectory && info.uid === 0 && (info.mode & 0o1000) !== 0;
        check(info.isDirectory() && [0, process.getuid()].includes(info.uid));
        check(
          privateDirectory
            ? info.uid === process.getuid() && (info.mode & 0o7777) === 0o700
            : (info.mode & 0o022) === 0 || sticky,
        );
      }
      check(fs.realpathSync(directory) === directory);
    };
    const read = (relative) => {
      check(sources.has(relative));
      const absolute = `${root}/${relative}`;
      directories(path.dirname(absolute));
      let handle;
      try {
        handle = fs.openSync(
          absolute,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
        );
        const initial = fs.fstatSync(handle);
        const metadata = (info) =>
          check(
            info.isFile() &&
              info.nlink === 1 &&
              info.uid === process.getuid() &&
              (info.mode & 0o7777) === 0o600 &&
              info.size <= limit,
          );
        metadata(initial);
        const buffer = Buffer.alloc(initial.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = fs.readSync(handle, buffer, length, buffer.length - length, null);
          if (count === 0) break;
          length += count;
        }
        metadata(fs.fstatSync(handle));
        check(length === initial.size);
        const bytes = buffer.subarray(0, length);
        check(crypto.createHash("sha256").update(bytes).digest("hex") === sources.get(relative));
        check(fs.lstatSync(absolute).ino === initial.ino && fs.realpathSync(absolute) === absolute);
        return bytes;
      } finally {
        if (handle !== undefined) fs.closeSync(handle);
      }
    };
    const verifySources = async () => {
      for (const relative of sources.keys()) read(relative);
    };
    await verifySources();
    const relativeUrl = (value) => {
      check(value.startsWith("file:"));
      const absolute = url.fileURLToPath(value);
      check(absolute.startsWith(`${root}/`) && url.pathToFileURL(absolute).href === value);
      const relative = absolute.slice(root.length + 1);
      check(sources.has(relative));
      return relative;
    };
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier.startsWith("node:")) {
          check(isBuiltin(specifier));
          return nextResolve(specifier, context);
        }
        check(specifier.startsWith("file:") || /^\.{1,2}\//u.test(specifier));
        const result = nextResolve(specifier, context);
        relativeUrl(result.url);
        return result;
      },
      load(moduleUrl, context, nextLoad) {
        if (moduleUrl.startsWith("node:")) return nextLoad(moduleUrl, context);
        return { format: "module", source: read(relativeUrl(moduleUrl)), shortCircuit: true };
      },
    });
    const { executeConfigurationOperation } = await import(
      url.pathToFileURL(`${root}/${entry}`).href
    );
    const { sourceFiles: ignored, ...operation } = input;
    void ignored;
    const result = await executeConfigurationOperation({ ...operation, verifySources });
    check(
      result?.status === "healthy" &&
        result.operationId === input.operationId &&
        typeof result.apiId === "string" &&
        result.apiId.length > 0,
    );
    process.stdout.write('{"configuration":"healthy"}\n');
  } catch {
    process.stderr.write("Protected configuration execution failed; preserve host evidence.\n");
    process.exitCode = 1;
  }
}
export const CONFIGURATION_LOADER = `await (${configurationLoader.toString()})();`;

export function configurationSshArguments(target, operationId, planSha256, dispatch) {
  validateUpgradeDispatch(dispatch);
  ensure(typeof planSha256 === "string" && /^[a-f0-9]{64}$/u.test(planSha256));
  const args = recoverySshArguments(
    target,
    "execute",
    operationId,
    "prepare",
    dispatch.toolingSha,
    dispatch,
  );
  const quoted = `'${CONFIGURATION_LOADER.replaceAll("'", "'\\''")}'`;
  return [
    ...args.slice(0, -1),
    `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C /usr/bin/node --input-type=module --eval ${quoted}`,
  ];
}

export async function runConfigurationTransport(
  values,
  {
    request = fetch,
    runProcess = runHostProcess,
    checkoutRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  } = {},
) {
  let temporary;
  let terminationConfirmed = true;
  try {
    ensure(
      Array.isArray(values) &&
        values.length === 15 &&
        values.every((value) => typeof value === "string" && !value.includes("\0")),
    );
    const [
      host,
      port,
      user,
      privateKey,
      knownHosts,
      token,
      actorLogin,
      toolingSha,
      runId,
      runAttempt,
      executorSha,
      executorCiRunId,
      executorCiRunAttempt,
      operationId,
      planSha256,
    ] = values;
    ensure(
      toolingSha === executorSha &&
        /^[1-9][0-9]{0,19}$/u.test(executorCiRunId) &&
        executorCiRunAttempt === "1",
    );
    const dispatch = validateUpgradeDispatch({ toolingSha, runId, runAttempt });
    // Validate all nonsecret command fields before network requests or temporary files.
    configurationSshArguments(
      { host, port, user, identityFile: "/tmp/identity", knownHostsFile: "/tmp/known-hosts" },
      operationId,
      planSha256,
      dispatch,
    );
    await verifyConfigurationDispatch(dispatch, token, { actorLogin, request });
    const ci = await fetchPlatformCi(
      { repository: REPOSITORY, sourceSha: executorSha, runId: executorCiRunId },
      token,
      githubTransport(token, request).ciRequest,
    );
    ensure(ci.identity.ciRunAttempt === executorCiRunAttempt);
    await assertNoCatalogPeers(dispatch, token, request);
    const sourceFiles = await sourceClosure(checkoutRoot);
    const input = Buffer.from(
      JSON.stringify({
        token,
        actorLogin,
        sourceFiles,
        operationId,
        planSha256,
        dispatch,
        executorCiRunId,
        executorCiRunAttempt,
      }),
    );
    ensure(input.length <= LIMIT);
    temporary = await realpath(await mkdtemp(join(tmpdir(), "dadata-transport-")));
    await chmod(temporary, 0o700);
    await writePrivateFile(temporary, "identity", Buffer.from(privateKey + "\n"));
    await writePrivateFile(temporary, "known-hosts", Buffer.from(knownHosts + "\n"));
    const target = {
      host,
      port,
      user,
      identityFile: join(temporary, "identity"),
      knownHostsFile: join(temporary, "known-hosts"),
    };
    let result;
    try {
      result = await runProcess({
        executable: "/usr/bin/ssh",
        args: configurationSshArguments(target, operationId, planSha256, dispatch),
        cwd: temporary,
        env: CLEAN_ENV,
        timeoutMs: 3600000,
        outputLimitBytes: LIMIT,
        input,
      });
    } catch (error) {
      terminationConfirmed = error?.terminationConfirmed === true;
      throw error;
    }
    ensure(
      result.stderr.length === 0 && result.stdout.toString() === '{"configuration":"healthy"}\n',
    );
    return { configuration: "healthy" };
  } catch {
    throw new Error(FAILURE.trim());
  } finally {
    // Unknown SSH process lifetime retains its own credential directory for reconciliation.
    if (temporary && terminationConfirmed)
      await rm(temporary, { recursive: true, force: true, maxRetries: 0 });
  }
}
async function cli() {
  try {
    ensure(process.argv.length === 3 && process.argv[2] === "run");
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      ensure(size <= LIMIT);
      chunks.push(chunk);
    }
    const values = new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks))
      .split("\0");
    ensure(values.length === 16 && values.pop() === "");
    const result = await runConfigurationTransport(values);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write(FAILURE);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await cli();
