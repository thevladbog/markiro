/* global window */
// Processes and pages of the instruction stand: the real host, the webview's vite server and a
// Chromium page per computer whose Tauri shell is `shell.mjs`.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { StandShell, hostCall } from "./shell.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, "../../..");
const REPO = path.resolve(APP_DIR, "../..");
const require = createRequire(import.meta.url);

export function loadChromium() {
  const core =
    process.env.PLAYWRIGHT_CORE ??
    path.join(
      REPO,
      "tools/production-browser/node_modules/.pnpm/playwright-core@1.62.0/node_modules/playwright-core",
    );
  return require(core).chromium;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, what, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

/** `markiro-host run` over `dataDir`; resolves once `hello` answers. */
/** `stand-clock.c` built once into the stand's cache. */
export function clockLibrary(cacheDir) {
  const library = path.join(cacheDir, "stand-clock.dylib");
  if (!existsSync(library)) {
    mkdirSync(cacheDir, { recursive: true });
    execFileSync("clang", ["-dynamiclib", "-o", library, path.join(here, "stand-clock.c")]);
  }
  return library;
}

/**
 * `markiro-host run` over `dataDir`; resolves once `hello` answers. With `clockAt` the host's
 * wall clock starts at that instant (`stand-clock.c`), so its records carry the stand's day.
 */
export async function startHost({
  dataDir,
  port,
  clockAt,
  cacheDir,
  binary = path.join(APP_DIR, "target/debug/markiro-host"),
}) {
  if (!existsSync(binary)) {
    throw new Error(
      `no ${binary}: run cargo build -p markiro-host --manifest-path apps/standalone/Cargo.toml`,
    );
  }
  mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" };
  if (clockAt !== undefined) {
    env.DYLD_INSERT_LIBRARIES = clockLibrary(cacheDir);
    env.STAND_CLOCK_OFFSET = String(Math.round((clockAt.getTime() - Date.now()) / 1000));
  }
  const child = spawn(binary, ["run", "--data-dir", dataDir, "--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const connect = { host: "127.0.0.1", port, certFile: path.join(dataDir, "tls", "cert.der") };
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`markiro-host exited: ${stderr}`);
    return (
      (await hostCall(connect, { method: "GET", path: "/v1/hello", timeoutMs: 1000 })).status ===
      200
    );
  }, "markiro-host");
  return {
    connect,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) =>
        // A host a state already stopped has exited by its signal (`exitCode` stays null).
        child.exitCode === null && child.signalCode === null
          ? child.once("exit", resolve)
          : resolve(),
      );
    },
  };
}

/** The webview's own vite server (`apps/standalone`, as `tauri dev` serves it). */
export async function startVite({ port }) {
  const child = spawn(
    path.join(APP_DIR, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: APP_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const url = `http://127.0.0.1:${port}/`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`vite exited: ${output}`);
    return (await fetch(url)).ok;
  }, "vite");
  return { url, stop: async () => child.kill("SIGTERM") };
}

/**
 * One computer of the site: a Chromium context whose shell keeps its pairing in
 * `<stateDir>/<name>.json` and its local database in `<stateDir>/<name>.db`.
 */
export async function openComputer(
  browser,
  {
    name,
    role,
    connect,
    displayAddress,
    stateDir,
    url,
    clock,
    fixedClock,
    theme,
    log,
    openPage = true,
  },
) {
  mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${name}.json`);
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    colorScheme: theme ?? "light",
    reducedMotion: "reduce",
  });
  // A flowing clock while the seed works (scans keep their own seconds); a fixed one for frames.
  if (clock !== undefined) await context.clock.install({ time: clock });
  if (fixedClock !== undefined) await context.clock.setFixedTime(fixedClock);
  const start = clock ?? fixedClock;
  const clockOffsetMs = start === undefined ? 0 : start.getTime() - Date.now();
  let page;
  const emit = (event, payload) => {
    page?.evaluate(([e, p]) => window.__standEmit?.(e, p), [event, payload]).catch(() => {});
  };
  const shell = new StandShell({
    role,
    connect,
    displayAddress,
    localDbPath: path.join(stateDir, `${name}.db`),
    state,
    emit,
    now: () => Date.now() + clockOffsetMs,
    log: (line) => log?.(`[${name}] ${line}`),
  });
  await context.exposeBinding("__standShell", async (_source, command, args) => {
    try {
      const value = await shell.handle(command, args ?? {});
      if (process.env.STAND_TRACE)
        log?.(`[${name}] ${command} ${JSON.stringify(args).slice(0, 160)} -> ok`);
      return { value: value === undefined ? null : value };
    } catch (error) {
      const code = typeof error === "string" ? error : String(error?.message ?? error);
      log?.(`[${name}] ${command} ${JSON.stringify(args).slice(0, 160)} -> ${code}`);
      return { error: code };
    }
  });
  await context.addInitScript({ path: path.join(here, "tauri-init.js") });
  page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      log?.(`[${name}] console.${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => log?.(`[${name}] pageerror: ${error.message}`));
  if (openPage) await page.goto(url);
  return {
    page,
    url,
    open: () => page.goto(url),
    shell,
    context,
    save() {
      writeFileSync(stateFile, JSON.stringify(shell.device, null, 2));
    },
    async close() {
      writeFileSync(stateFile, JSON.stringify(shell.device, null, 2));
      shell.close();
      await context.close();
    },
  };
}
