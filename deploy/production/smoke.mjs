import { spawn } from "node:child_process";
import process from "node:process";

const CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const COMMAND_TIMEOUT_MS = 30_000;

function timeoutError(command, timeoutMs) {
  return new Error(`${command} timed out after ${timeoutMs}ms`);
}

function withDeadline(promise, command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(command, timeoutMs)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const ROUTE_CHECKS = Object.freeze([
  Object.freeze({
    method: "GET",
    path: "/",
    kind: "admin-shell",
    expected: "200 HTML admin shell",
  }),
  Object.freeze({
    method: "GET",
    path: "/assets/${assetName}",
    kind: "asset",
    expected: "200, immutable cache",
  }),
  Object.freeze({
    method: "GET",
    path: "/team/deep-link",
    kind: "admin-shell",
    expected: "200 admin shell, no-cache",
  }),
  Object.freeze({
    method: "GET",
    path: "/api/auth/get-session",
    kind: "proxy",
    expected: "not SPA; upstream path retains /api/auth/",
  }),
  Object.freeze({
    method: "GET",
    path: "/api/health/live",
    kind: "json",
    expected: "200 JSON from upstream /health/live",
  }),
  Object.freeze({
    method: "GET",
    path: "/api/health/ready",
    kind: "ready-json",
    expected: "200 JSON from upstream /health/ready",
  }),
  Object.freeze({ method: "GET", path: "/station/bootstrap", kind: "proxy", expected: "not SPA" }),
  Object.freeze({ method: "GET", path: "/kiosk/bootstrap", kind: "proxy", expected: "not SPA" }),
  Object.freeze({
    method: "POST",
    path: "/1c_exchange",
    kind: "commerce-ml",
    expected: "not SPA and request body reaches API unchanged",
  }),
  Object.freeze({ method: "GET", path: "/health/live", kind: "json", expected: "200 JSON" }),
  Object.freeze({
    method: "GET",
    path: "/health/ready",
    kind: "ready-json",
    expected: "200 JSON ok or degraded",
  }),
  Object.freeze({ method: "GET", path: "/openapi.json", kind: "json", expected: "200 JSON" }),
  Object.freeze({
    method: "GET",
    path: "/docs",
    kind: "proxy-html",
    expected: "upstream HTML, not admin shell",
  }),
  Object.freeze({ method: "POST", path: "/unknown", kind: "not-found", expected: "404, not HTML" }),
]);

function dockerRunner(environment, timeoutMs) {
  return {
    run(command, args) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        let timedOut = false;
        const child = spawn(command, args, {
          env: { ...process.env, ...environment },
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          reject(timeoutError(command, timeoutMs));
        }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", () => {
          clearTimeout(timer);
          if (!timedOut) reject(new Error(`${command} failed`));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (!timedOut)
            resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - startedAt });
        });
      });
    },
  };
}

function requestClient() {
  return { request: (url, init) => fetch(url, init) };
}

function composeArgs(environment) {
  return [
    "compose",
    "--env-file",
    environment.MARKIRO_ENV_FILE || ".env.production",
    "-f",
    "compose.production.yml",
  ];
}

function assertHeaders(response, requiresHsts) {
  const headers = response.headers;
  if (headers.get("content-security-policy") !== CSP)
    throw new Error("CSP is not the production policy");
  if (
    requiresHsts &&
    headers.get("strict-transport-security") !== "max-age=63072000; includeSubDomains"
  )
    throw new Error("HSTS is missing");
  if (headers.get("x-content-type-options") !== "nosniff") throw new Error("nosniff is missing");
  if (headers.get("x-frame-options") !== "SAMEORIGIN") throw new Error("SAMEORIGIN is missing");
  if (headers.get("referrer-policy") !== "strict-origin-when-cross-origin")
    throw new Error("referrer policy is missing");
}

function shellSignature(html) {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  const modulePath = [...html.matchAll(/<script\b([^>]*)>/gi)]
    .map((match) => match[1])
    .find((attributes) => /\btype\s*=\s*["']module["']/i.test(attributes))
    ?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  return title && modulePath?.startsWith("/assets/") ? { title, modulePath } : null;
}

function assertNoExternalOrigins(html, baseUrl) {
  const assertUrl = (value) => {
    if (value.startsWith("//")) throw new Error("built index contains an external origin");
    if (/^https?:\/\//i.test(value) && new URL(value).origin !== new URL(baseUrl).origin)
      throw new Error("built index contains an external origin");
  };
  for (const match of html.matchAll(
    /\b(?:src|href|action|poster|formaction)\s*=\s*["']([^"']+)["']/gi,
  )) {
    assertUrl(match[1]);
  }
  for (const match of html.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const source of match[1].split(",")) assertUrl(source.trim().split(/\s+/, 1)[0]);
  }
}

async function getText(response) {
  return response.text();
}

async function publicRequest(client, url, init) {
  const signal = AbortSignal.timeout(5_000);
  return client.request(url, { ...init, signal });
}

function assertRoute(check, response, body, signature) {
  const isShell = Boolean(
    signature &&
    shellSignature(body)?.title === signature.title &&
    body.includes(signature.modulePath),
  );
  if (check.kind !== "admin-shell" && isShell)
    throw new Error(`${check.path} returned the admin shell`);
  if (check.kind === "admin-shell") {
    if (
      response.status !== 200 ||
      !/text\/html/i.test(response.headers.get("content-type") || "") ||
      !isShell
    )
      throw new Error(`${check.path} did not return the admin shell`);
    if (response.headers.get("cache-control") !== "no-cache")
      throw new Error(`${check.path} must be no-cache`);
  }
  if (check.kind === "asset") {
    if (
      response.status !== 200 ||
      response.headers.get("cache-control") !== "public, max-age=31536000, immutable"
    )
      throw new Error("asset cache contract failed");
  }
  if (check.kind === "json") {
    if (
      response.status !== 200 ||
      !/application\/json/i.test(response.headers.get("content-type") || "")
    )
      throw new Error(`${check.path} did not return JSON`);
    try {
      JSON.parse(body);
    } catch {
      throw new Error(`${check.path} did not return valid JSON`);
    }
  }
  if (check.kind === "ready-json") {
    let readiness;
    try {
      readiness = JSON.parse(body);
    } catch {
      throw new Error(`${check.path} did not return valid JSON`);
    }
    if (
      response.status !== 200 ||
      !/application\/json/i.test(response.headers.get("content-type") || "") ||
      !["ok", "degraded"].includes(readiness.status)
    )
      throw new Error(`${check.path} did not return an acceptable readiness report`);
  }
  if (check.kind === "proxy") {
    if (
      ![200, 401, 403].includes(response.status) ||
      !/application\/json/i.test(response.headers.get("content-type") || "")
    )
      throw new Error(`${check.path} did not return an upstream JSON proxy response`);
    try {
      JSON.parse(body);
    } catch {
      throw new Error(`${check.path} did not return valid JSON`);
    }
  }
  if (
    check.kind === "proxy-html" &&
    (response.status !== 200 || !/text\/html/i.test(response.headers.get("content-type") || ""))
  )
    throw new Error("docs did not return upstream HTML");
  if (
    check.kind === "commerce-ml" &&
    (response.status !== 200 ||
      !/text\/plain/i.test(response.headers.get("content-type") || "") ||
      !/^(success|failure)/i.test(body) ||
      isShell)
  )
    throw new Error("1C exchange did not reach the API");
  if (check.kind === "not-found" && (response.status !== 404 || /<html/i.test(body)))
    throw new Error("unknown POST must be a non-HTML 404");
}

async function runDocker(docker, args, commandTimeoutMs) {
  try {
    return await withDeadline(docker.run("docker", args), "docker", commandTimeoutMs);
  } catch (error) {
    if (error?.message === `docker timed out after ${commandTimeoutMs}ms`) throw error;
    throw new Error("docker failed");
  }
}

async function waitForRestoredReadiness(client, baseUrl, attempts, intervalMs, sleep) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await publicRequest(client, new URL("/health/ready", baseUrl), {
        method: "GET",
      });
      const body = await response.text();
      if (
        response.status === 200 &&
        /application\/json/i.test(response.headers.get("content-type") || "") &&
        ["ok", "degraded"].includes(JSON.parse(body).status)
      )
        return;
    } catch {
      // The restored API may still be accepting its first connection.
    }
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  throw new Error("API did not become ready after shutdown smoke");
}

async function runtimeSmoke(environment, docker, client, baseUrl, options) {
  const compose = composeArgs(environment);
  const port = await runDocker(
    docker,
    [...compose, "port", "api", "3000"],
    options.commandTimeoutMs,
  );
  if (port.code === 0 && port.stdout.trim()) throw new Error("API is published on the host");
  const uid = await runDocker(
    docker,
    [...compose, "exec", "-T", "api", "id", "-u"],
    options.commandTimeoutMs,
  );
  if (uid.code !== 0 || !uid.stdout.trim() || uid.stdout.trim() === "0")
    throw new Error("API is running as root");
  const rootWritable = await runDocker(
    docker,
    [...compose, "exec", "-T", "api", "test", "-w", "/"],
    options.commandTimeoutMs,
  );
  if (rootWritable.code === 0) throw new Error("API root filesystem is writable");

  if (environment.SMOKE_ASSERT_SHUTDOWN !== "1") return;
  const id = await runDocker(docker, [...compose, "ps", "-q", "api"], options.commandTimeoutMs);
  const containerId = id.stdout.trim();
  if (id.code !== 0 || !containerId) throw new Error("API container ID is unavailable");
  let stopError;
  let restoreError;
  let stopAttempted = false;
  try {
    stopAttempted = true;
    const stopped = await runDocker(
      docker,
      ["stop", "--time", "25", containerId],
      options.commandTimeoutMs,
    );
    if (stopped.code !== 0 || (stopped.durationMs ?? 0) > 30_000)
      throw new Error("API did not stop gracefully");
  } catch (error) {
    stopError = error;
  } finally {
    if (stopAttempted) {
      try {
        const restored = await runDocker(
          docker,
          [...compose, "up", "-d", "--no-deps", "api"],
          options.commandTimeoutMs,
        );
        if (restored.code !== 0) throw new Error("API was not restored after shutdown smoke");
        await waitForRestoredReadiness(
          client,
          baseUrl,
          options.readinessAttempts,
          options.readinessIntervalMs,
          options.sleep,
        );
      } catch (error) {
        restoreError = error;
      }
    }
  }
  if (stopError) {
    if (restoreError) stopError.restoreError = restoreError;
    throw stopError;
  }
  if (restoreError) throw restoreError;
}

/**
 * @param {{baseUrl: string, assetName?: string, environment?: Record<string, string | undefined>, commandTimeoutMs?: number, readinessAttempts?: number, readinessIntervalMs?: number, sleep?: (milliseconds: number) => Promise<void>}} options
 * @param {{request(url: string | URL, init: RequestInit): Promise<{status: number, headers: Headers, text(): Promise<string>}>}=} client
 * @param {{run(command: string, args: string[]): Promise<{code: number, stdout: string, stderr: string, durationMs?: number}>}=} docker
 */
export async function runSmoke(options, client = requestClient(), docker) {
  const environment = options.environment || process.env;
  const runtimeOptions = {
    commandTimeoutMs: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
    readinessAttempts: options.readinessAttempts ?? 30,
    readinessIntervalMs: options.readinessIntervalMs ?? 2_000,
    sleep:
      options.sleep ||
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
  const dockerClient = docker || dockerRunner(environment, runtimeOptions.commandTimeoutMs);
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const root = await publicRequest(client, new URL("/", baseUrl), { method: "GET" });
  const rootHtml = await getText(root);
  assertHeaders(root, new URL(baseUrl).protocol === "https:");
  const signature = shellSignature(rootHtml);
  if (root.status !== 200 || !signature)
    throw new Error("root did not return the built admin shell");
  assertNoExternalOrigins(rootHtml, baseUrl);

  for (const check of ROUTE_CHECKS) {
    const path = check.path.replace(
      "${assetName}",
      options.assetName || signature.modulePath.slice("/assets/".length),
    );
    const init =
      check.kind === "commerce-ml"
        ? {
            method: "POST",
            body: "type=catalog&mode=checkauth",
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }
        : { method: check.method };
    const response =
      check.path === "/" ? root : await publicRequest(client, new URL(path, baseUrl), init);
    const body = check.path === "/" ? rootHtml : await getText(response);
    assertHeaders(response, new URL(baseUrl).protocol === "https:");
    assertRoute(check, response, body, signature);
  }
  await runtimeSmoke(environment, dockerClient, client, baseUrl, runtimeOptions);
}

if (import.meta.main) {
  try {
    await runSmoke({ baseUrl: `https://${process.env.MARKIRO_DOMAIN}`, environment: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
