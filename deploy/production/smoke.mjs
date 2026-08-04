import { spawn } from "node:child_process";
import process from "node:process";

const CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";

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
    expected: "200 immutable cache",
  }),
  Object.freeze({
    method: "GET",
    path: "/team/deep-link",
    kind: "admin-shell",
    expected: "200 admin shell no-cache",
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
    expected: "upstream HTML not admin shell",
  }),
  Object.freeze({ method: "POST", path: "/unknown", kind: "not-found", expected: "404 not HTML" }),
]);

function dockerRunner() {
  return {
    run(command, args) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("close", (code) =>
          resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - startedAt }),
        );
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
  const modulePath = html.match(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/i)?.[1];
  return title && modulePath?.startsWith("/assets/") ? { title, modulePath } : null;
}

function assertNoExternalOrigins(html, baseUrl) {
  for (const match of html.matchAll(/(?:src|href|action|poster)=["']([^"']+)["']/gi)) {
    const value = match[1];
    if (value.startsWith("//")) throw new Error("built index contains an external origin");
    if (/^https?:\/\//i.test(value) && new URL(value).origin !== new URL(baseUrl).origin)
      throw new Error("built index contains an external origin");
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
    if (response.status !== 200 || !isShell)
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
  if (
    check.kind === "json" &&
    (response.status !== 200 ||
      !/application\/json/i.test(response.headers.get("content-type") || ""))
  )
    throw new Error(`${check.path} did not return JSON`);
  if (check.kind === "ready-json") {
    if (
      response.status !== 200 ||
      !/application\/json/i.test(response.headers.get("content-type") || "") ||
      !["ok", "degraded"].includes(JSON.parse(body).status)
    )
      throw new Error(`${check.path} did not return an acceptable readiness report`);
  }
  if (
    check.kind === "proxy-html" &&
    (response.status !== 200 || !/text\/html/i.test(response.headers.get("content-type") || ""))
  )
    throw new Error("docs did not return upstream HTML");
  if (check.kind === "commerce-ml" && (response.status >= 500 || isShell))
    throw new Error("1C exchange did not reach the API");
  if (check.kind === "not-found" && (response.status !== 404 || /<html/i.test(body)))
    throw new Error("unknown POST must be a non-HTML 404");
}

async function runtimeSmoke(environment, docker, client, baseUrl) {
  const compose = composeArgs(environment);
  const port = await docker.run("docker", [...compose, "port", "api", "3000"]);
  if (port.code === 0 && port.stdout.trim()) throw new Error("API is published on the host");
  const uid = await docker.run("docker", [...compose, "exec", "-T", "api", "id", "-u"]);
  if (uid.code !== 0 || !uid.stdout.trim() || uid.stdout.trim() === "0")
    throw new Error("API is running as root");
  const rootWritable = await docker.run("docker", [
    ...compose,
    "exec",
    "-T",
    "api",
    "test",
    "-w",
    "/",
  ]);
  if (rootWritable.code === 0) throw new Error("API root filesystem is writable");

  if (environment.SMOKE_ASSERT_SHUTDOWN !== "1") return;
  const id = await docker.run("docker", [...compose, "ps", "-q", "api"]);
  const containerId = id.stdout.trim();
  if (id.code !== 0 || !containerId) throw new Error("API container ID is unavailable");
  const stopped = await docker.run("docker", ["stop", "--time", "25", containerId]);
  if (stopped.code !== 0 || (stopped.durationMs ?? 0) > 30_000)
    throw new Error("API did not stop gracefully");
  const restored = await docker.run("docker", [...compose, "up", "-d", "--no-deps", "api"]);
  if (restored.code !== 0) throw new Error("API was not restored after shutdown smoke");
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await publicRequest(client, new URL("/health/ready", baseUrl), {
        method: "GET",
      });
      ready = response.status === 200;
    } catch {
      ready = false;
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!ready) throw new Error("API did not become ready after shutdown smoke");
}

/**
 * @param {{baseUrl: string, assetName?: string, environment?: Record<string, string | undefined>}} options
 * @param {{request(url: string | URL, init: RequestInit): Promise<{status: number, headers: Headers, text(): Promise<string>}>}=} client
 * @param {{run(command: string, args: string[]): Promise<{code: number, stdout: string, stderr: string, durationMs?: number}>}=} docker
 */
export async function runSmoke(options, client = requestClient(), docker = dockerRunner()) {
  const environment = options.environment || process.env;
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
  await runtimeSmoke(environment, docker, client, baseUrl);
}

if (import.meta.main) {
  try {
    await runSmoke({ baseUrl: `https://${process.env.MARKIRO_DOMAIN}`, environment: process.env });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
