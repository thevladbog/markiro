import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import { productionComposeArgs } from "./compose-files.mjs";
import { validateProductionDomains, validateVbtechDomains } from "./production-domain.mjs";
import { RUNTIME_DEPENDENCY_PROBE_SOURCE } from "./runtime-dependency-probe.mjs";

const APPLICATION_CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob: https://storage.yandexcloud.net; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const LANDING_CSP =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob: https://*.google-analytics.com https://www.googletagmanager.com https://mc.yandex.ru; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://smartcaptcha.cloud.yandex.ru https://cdn.jsdelivr.net/gh/yandex/webmaster-gtm-template@467fdc0c3ab3124a40ddf229fc8cd20392c71938/webmaster-verification.js https://www.googletagmanager.com https://mc.yandex.ru https://yastatic.net; frame-src 'self' https://smartcaptcha.cloud.yandex.ru https://mc.yandex.ru; connect-src 'self' https://smartcaptcha.cloud.yandex.ru https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://mc.yandex.ru wss://mc.yandex.ru; worker-src 'self' blob:; manifest-src 'self'";
const VBTECH_CSP =
  "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src https://smartcaptcha.cloud.yandex.ru; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline' https://smartcaptcha.cloud.yandex.ru; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests";
const LANDING_SITE_URL = "https://markiro.app";
const STATION_STABLE_DOWNLOAD_URL = "https://releases.markiro.app/station/download";
const COMMAND_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
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
  Object.freeze({
    method: "GET",
    path: "/station/bootstrap",
    kind: "station-proxy",
    expected: "not SPA",
  }),
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
    kind: "docs",
    expected: "same-origin executable documentation shell",
  }),
  Object.freeze({
    method: "GET",
    path: "/api/demo-requests",
    kind: "not-found",
    expected: "404, not HTML on admin authority",
  }),
  Object.freeze({
    method: "POST",
    path: "/api/demo-requests",
    kind: "not-found",
    expected: "404, not HTML on admin authority",
  }),
  Object.freeze({ method: "POST", path: "/unknown", kind: "not-found", expected: "404, not HTML" }),
]);

export const SAAS_ADMIN_ROUTE_CHECKS = Object.freeze([
  Object.freeze(["GET", "/", "saas-shell"]),
  Object.freeze(["GET", "/login", "saas-shell"]),
  Object.freeze(["GET", "/assets/${assetName}", "asset"]),
  Object.freeze(["GET", "/api/platform-auth/get-session", "platform-proxy"]),
  Object.freeze(["GET", "/api/platform/catalog", "platform-proxy"]),
  Object.freeze(["GET", "/api/auth/get-session", "not-found"]),
  Object.freeze(["GET", "/api/health/ready", "not-found"]),
  Object.freeze(["GET", "/station/bootstrap", "not-found"]),
  Object.freeze(["POST", "/unknown", "not-found"]),
]);

export const KIOSK_ROUTE_CHECKS = Object.freeze([
  Object.freeze(["GET", "/", "kiosk-shell"]),
  Object.freeze(["GET", "/assets/${assetName}", "asset"]),
  Object.freeze(["GET", "/manifest.webmanifest", "manifest"]),
  Object.freeze(["GET", "/sw.js", "service-worker"]),
  Object.freeze(["GET", "/api/kiosk/bootstrap", "kiosk-proxy"]),
  Object.freeze(["GET", "/api", "not-found"]),
  Object.freeze(["HEAD", "/api", "not-found"]),
  Object.freeze(["GET", "/api/auth/get-session", "not-found"]),
  Object.freeze(["GET", "/station", "not-found"]),
  Object.freeze(["HEAD", "/station", "not-found"]),
  Object.freeze(["GET", "/station/bootstrap", "not-found"]),
  Object.freeze(["GET", "/kiosk", "not-found"]),
  Object.freeze(["HEAD", "/kiosk", "not-found"]),
  Object.freeze(["GET", "/docs", "not-found"]),
  Object.freeze(["POST", "/unknown", "not-found"]),
]);

export const LANDING_ROUTE_CHECKS = Object.freeze([
  Object.freeze(["GET", "/", "landing-page"]),
  Object.freeze(["GET", "/faq/", "landing-page"]),
  Object.freeze(["GET", "/en/", "landing-page"]),
  Object.freeze(["GET", "/en/chestny-znak-serialization/", "landing-page"]),
  Object.freeze(["GET", "/en/sscc-and-aggregation/", "landing-page"]),
  Object.freeze(["GET", "/en/packing-workstation/", "landing-page"]),
  Object.freeze(["GET", "/en/self-service-pickup-kiosk/", "landing-page"]),
  Object.freeze(["GET", "/en/1c-integration/", "landing-page"]),
  Object.freeze(["GET", "/en/offline-production/", "landing-page"]),
  Object.freeze(["GET", "/en/faq/", "landing-page"]),
  Object.freeze(["GET", "/legal/", "landing-page"]),
  Object.freeze(["GET", "/privacy/", "landing-page"]),
  Object.freeze(["GET", "/personal-data-consent/", "landing-page"]),
  Object.freeze(["GET", "/d/MKR-PD-01/2026.08/01/15.08.2026", "landing-page"]),
  Object.freeze(["GET", "/robots.txt", "robots"]),
  Object.freeze(["GET", "/sitemap.xml", "sitemap"]),
  Object.freeze(["GET", "/llms.txt", "llms"]),
  Object.freeze(["GET", "/api/demo-requests", "not-found"]),
  Object.freeze(["HEAD", "/api/demo-requests", "not-found"]),
  Object.freeze(["PUT", "/api/demo-requests", "not-found"]),
  Object.freeze(["POST", "/api/demo-request", "not-found"]),
  Object.freeze(["POST", "/api/demo-requests/", "not-found"]),
  Object.freeze(["POST", "/api/demo-requests/extra", "not-found"]),
  Object.freeze(["POST", "/api/other", "not-found"]),
  Object.freeze(["GET", "/missing/", "branded-not-found"]),
]);

export const VBTECH_ROUTE_CHECKS = Object.freeze([
  Object.freeze(["GET", "/", "vbtech-page"]),
  Object.freeze(["GET", "/en/", "vbtech-page"]),
  Object.freeze(["GET", "/legal/", "vbtech-page"]),
  Object.freeze(["GET", "/privacy/", "vbtech-page"]),
  Object.freeze(["GET", "/personal-data-consent/", "vbtech-page"]),
  Object.freeze(["GET", "/api/contact", "not-found"]),
  Object.freeze(["POST", "/api/contact/", "not-found"]),
  Object.freeze(["POST", "/api/other", "not-found"]),
  Object.freeze(["GET", "/api/auth/get-session", "not-found"]),
  Object.freeze(["GET", "/station/bootstrap", "vbtech-not-found"]),
  Object.freeze(["GET", "/kiosk/bootstrap", "vbtech-not-found"]),
  Object.freeze(["POST", "/api/contact", "contact-state"]),
]);

function productionBaseUrl(domain, port) {
  const authority = port && port !== "443" ? `${domain}:${port}` : domain;
  return `https://${authority}`;
}

export function landingDemoSubmissionState(value) {
  if (value !== "disabled" && value !== "enabled")
    throw new Error("landing demo submission smoke state is invalid");
  return value;
}

export function vbtechSubmissionState(value) {
  if (value !== "disabled" && value !== "enabled")
    throw new Error("v-b contact submission smoke state is invalid");
  return value;
}

export function productionBaseUrls(environment) {
  const { domain, saasAdminDomain, kioskDomain, landingDomain } = validateProductionDomains(
    environment.MARKIRO_DOMAIN,
    environment.MARKIRO_SAAS_ADMIN_DOMAIN,
    environment.MARKIRO_KIOSK_DOMAIN,
    environment.MARKIRO_LANDING_DOMAIN,
  );
  const isLocalSet =
    domain === "localhost" &&
    saasAdminDomain === "saas-admin.localhost" &&
    kioskDomain === "kiosk.localhost" &&
    landingDomain === "landing.localhost";
  if (domain === "localhost" && !isLocalSet) throw new Error("MARKIRO_DOMAIN is invalid");
  if (saasAdminDomain === "saas-admin.localhost" && !isLocalSet)
    throw new Error("MARKIRO_SAAS_ADMIN_DOMAIN is invalid");
  if (kioskDomain === "kiosk.localhost" && !isLocalSet)
    throw new Error("MARKIRO_KIOSK_DOMAIN is invalid");
  if (landingDomain === "landing.localhost" && !isLocalSet)
    throw new Error("MARKIRO_LANDING_DOMAIN is invalid");
  const port = environment.MARKIRO_HTTPS_PORT;
  const urls = {
    admin: productionBaseUrl(domain, port),
    saasAdmin: productionBaseUrl(saasAdminDomain, port),
    kiosk: productionBaseUrl(kioskDomain, port),
    landing: productionBaseUrl(landingDomain, port),
  };
  const vbtechConfigured = environment.VBTECH_IMAGE_REF !== undefined;
  if (!vbtechConfigured) return urls;
  const vbtech = validateVbtechDomains(environment.VBTECH_DOMAIN, environment.VBTECH_WWW_DOMAIN, [
    domain,
    saasAdminDomain,
    kioskDomain,
    landingDomain,
  ]);
  return {
    ...urls,
    vbtech: productionBaseUrl(vbtech.domain, port),
    vbtechWww: productionBaseUrl(vbtech.wwwDomain, port),
  };
}

function dockerRunner(environment, timeoutMs) {
  return {
    handlesDeadline: true,
    run(command, args) {
      return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        let timedOut = false;
        let killTimer;
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
          killTimer = setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
        }, timeoutMs);
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", () => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          reject(timedOut ? timeoutError(command, timeoutMs) : new Error(`${command} failed`));
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (killTimer) clearTimeout(killTimer);
          if (timedOut) reject(timeoutError(command, timeoutMs));
          else resolve({ code: code ?? 1, stdout, stderr, durationMs: Date.now() - startedAt });
        });
      });
    },
  };
}

function requestClient() {
  return { request: (url, init, signal) => fetch(url, { ...init, signal }) };
}

function assertHeaders(response, requiresHsts, routeLabel, expectedCsp = APPLICATION_CSP) {
  const headers = response.headers;
  const csp = headers.get("content-security-policy");
  if (csp !== expectedCsp)
    throw new Error(
      `CSP is ${csp === null ? "missing" : "not the production policy"} on ${routeLabel}`,
    );
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

function assertVbtechHeaders(response, requiresHsts, routeLabel, expectedReleaseSha) {
  const headers = response.headers;
  if (headers.get("content-security-policy") !== VBTECH_CSP)
    throw new Error(`v-b CSP is not the production policy on ${routeLabel}`);
  if (
    requiresHsts &&
    headers.get("strict-transport-security") !== "max-age=63072000; includeSubDomains"
  )
    throw new Error("v-b HSTS is missing");
  if (headers.get("x-content-type-options") !== "nosniff")
    throw new Error("v-b nosniff is missing");
  if (headers.get("x-frame-options") !== "DENY") throw new Error("v-b DENY is missing");
  if (headers.get("referrer-policy") !== "strict-origin-when-cross-origin")
    throw new Error("v-b referrer policy is missing");
  if (
    headers.get("permissions-policy") !==
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
  )
    throw new Error("v-b permissions policy is missing");
  if (headers.get("x-vbtech-release-sha") !== expectedReleaseSha)
    throw new Error("v-b release identity does not match the expected release");
}

function shellSignature(html) {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  const modulePath = [...html.matchAll(/<script\b([^>]*)>/gi)]
    .map((match) => match[1])
    .find((attributes) => /\btype\s*=\s*["']module["']/i.test(attributes))
    ?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  return title && modulePath?.startsWith("/assets/") ? { title, modulePath } : null;
}

function sameOriginPath(value, baseUrl, label) {
  if (typeof value !== "string" || value.startsWith("//")) throw new Error(`${label} is invalid`);
  const url = new URL(value, baseUrl);
  if (url.origin !== new URL(baseUrl).origin || url.search || url.hash)
    throw new Error(`${label} is not same-origin`);
  return url.pathname;
}

function kioskShellSignature(html, baseUrl) {
  const signature = shellSignature(html);
  const manifestHref = [...html.matchAll(/<link\b([^>]*)>/gi)]
    .map((match) => match[1])
    .find((attributes) => /\brel\s*=\s*["'][^"']*\bmanifest\b[^"']*["']/i.test(attributes))
    ?.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  const registrationSource = [...html.matchAll(/<script\b([^>]*)>/gi)]
    .map((match) => match[1])
    .find((attributes) => /\bid\s*=\s*["']vite-plugin-pwa:register-sw["']/i.test(attributes))
    ?.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (
    signature?.title !== "Маркиро — Киоск" ||
    !manifestHref ||
    !registrationSource ||
    !/<div\b[^>]*\bid\s*=\s*["']root["'][^>]*>/i.test(html)
  )
    return null;
  return {
    ...signature,
    manifestPath: sameOriginPath(manifestHref, baseUrl, "kiosk manifest link"),
    registrationPath: sameOriginPath(
      registrationSource,
      baseUrl,
      "kiosk service-worker registration",
    ),
  };
}

function assertNoExternalOrigins(
  html,
  baseUrl,
  allowedCanonicalUrl,
  allowedExternalOrigins = [],
  allowedExternalLinks = [],
) {
  const baseOrigin = new URL(baseUrl).origin;
  const allowedOriginSet = new Set(allowedExternalOrigins.map((value) => new URL(value).origin));
  const allowedExternalLinkSet = new Set(allowedExternalLinks);
  let runtimeHtml = html;
  if (allowedCanonicalUrl) {
    const allowedMetadataOrigin = new URL(allowedCanonicalUrl).origin;
    runtimeHtml = runtimeHtml.replace(/<link\b([^>]*)>/gi, (tag, attributes) => {
      const rel = attributes.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1];
      const href = attributes.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
      const relationships = rel?.split(/\s+/).map((value) => value.toLowerCase()) ?? [];
      if (relationships.includes("canonical") && href === allowedCanonicalUrl) return "";
      if (relationships.includes("alternate") && href) {
        const hreflang = attributes.match(/\bhreflang\s*=\s*["']([^"']+)["']/i)?.[1];
        try {
          if (
            ["ru", "en", "x-default"].includes(hreflang ?? "") &&
            new URL(href).origin === allowedMetadataOrigin
          )
            return "";
        } catch {
          return tag;
        }
      }
      return tag;
    });
  }
  runtimeHtml = runtimeHtml.replace(/<a\b[^>]*>/gi, (tag) =>
    tag.replace(/\bhref\s*=\s*(["'])([^"']+)\1/i, (attribute, _quote, href) =>
      allowedExternalLinkSet.has(href) ? "" : attribute,
    ),
  );
  const assertUrl = (value) => {
    if (!value.startsWith("//") && !/^https?:\/\//i.test(value)) return;
    const origin = new URL(value, baseUrl).origin;
    if (origin !== baseOrigin && !allowedOriginSet.has(origin))
      throw new Error("built index contains an external origin");
  };
  for (const match of runtimeHtml.matchAll(
    /\b(?:src|href|action|poster|formaction)\s*=\s*["']([^"']+)["']/gi,
  )) {
    assertUrl(match[1]);
  }
  for (const match of runtimeHtml.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) {
    for (const source of match[1].split(",")) assertUrl(source.trim().split(/\s+/, 1)[0]);
  }
}

function landingPageSignature(html, expectedUrl) {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  const canonicals = [...html.matchAll(/<link\b([^>]*)>/gi)]
    .map((match) => match[1])
    .filter((attributes) => /\brel\s*=\s*["'][^"']*\bcanonical\b[^"']*["']/i.test(attributes));
  const canonical = canonicals[0]?.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)];
  if (!title || canonicals.length !== 1 || canonical !== expectedUrl || headings.length !== 1)
    return null;
  return { title, canonical };
}

function assertLandingRoute(check, response, body, baseUrl, landingDemoSubmissionState) {
  const [, path, kind] = check;
  const contentType = response.headers.get("content-type") || "";
  if (kind === "not-found") {
    if (response.status !== 404 || /text\/html/i.test(contentType))
      throw new Error(`landing ${path} did not return a non-HTML 404`);
    return;
  }
  if (kind === "branded-not-found") {
    if (
      response.status !== 404 ||
      !/text\/html/i.test(contentType) ||
      !/<h1\b[^>]*>[\s\S]*?Revision not found[\s\S]*?<\/h1>/i.test(body) ||
      body.length > 50_000 ||
      /artifacts\.json|MKR-PD-0[12]|\.pdf/i.test(body)
    )
      throw new Error(`landing ${path} did not return the bounded branded 404`);
    if (response.headers.get("cache-control") !== "no-cache")
      throw new Error(`landing ${path} branded 404 is not revalidation-only`);
    return;
  }
  if (response.status !== 200) throw new Error(`landing ${path} is unavailable`);

  if (kind === "landing-page") {
    if (!/text\/html/i.test(contentType)) throw new Error(`landing ${path} is not HTML`);
    const expectedUrl = new URL(path, `${LANDING_SITE_URL}/`).href;
    if (!landingPageSignature(body, expectedUrl))
      throw new Error(`landing ${path} has an invalid title, canonical, or H1`);
    if (response.headers.get("cache-control") !== "no-cache")
      throw new Error(`landing ${path} is not revalidation-only`);
    const allowedExternalOrigins =
      landingDemoSubmissionState === "enabled" ? ["https://smartcaptcha.cloud.yandex.ru"] : [];
    assertNoExternalOrigins(body, baseUrl, expectedUrl, allowedExternalOrigins, [
      STATION_STABLE_DOWNLOAD_URL,
    ]);
    return;
  }

  if (response.headers.get("cache-control") !== "public, max-age=300")
    throw new Error(`landing ${path} has an invalid cache policy`);
  if (kind === "robots") {
    if (
      !/text\/plain/i.test(contentType) ||
      !/User-agent:\s*OAI-SearchBot[\s\S]*?Allow:\s*\//i.test(body) ||
      !/User-agent:\s*Claude-SearchBot[\s\S]*?Allow:\s*\//i.test(body) ||
      !/User-agent:\s*PerplexityBot[\s\S]*?Allow:\s*\//i.test(body) ||
      !/User-agent:\s*GPTBot[\s\S]*?Disallow:\s*\//i.test(body) ||
      !/User-agent:\s*ClaudeBot[\s\S]*?Disallow:\s*\//i.test(body) ||
      !body.includes(`Sitemap: ${new URL("/sitemap.xml", `${LANDING_SITE_URL}/`).href}`)
    )
      throw new Error("landing robots policy does not preserve search and training boundaries");
    return;
  }
  if (kind === "sitemap") {
    if (
      !/(?:application|text)\/xml/i.test(contentType) ||
      !body.includes(`<loc>${new URL("/", `${LANDING_SITE_URL}/`).href}</loc>`) ||
      !body.includes(`<loc>${new URL("/faq/", `${LANDING_SITE_URL}/`).href}</loc>`) ||
      !body.includes(`<loc>${new URL("/en/", `${LANDING_SITE_URL}/`).href}</loc>`) ||
      !body.includes(`<loc>${new URL("/en/faq/", `${LANDING_SITE_URL}/`).href}</loc>`)
    )
      throw new Error("landing sitemap does not expose canonical topic routes");
    return;
  }
  if (
    kind !== "llms" ||
    !/text\/plain/i.test(contentType) ||
    !body.includes(new URL("/", `${LANDING_SITE_URL}/`).href) ||
    !body.includes(new URL("/faq/", `${LANDING_SITE_URL}/`).href) ||
    !body.includes(new URL("/en/", `${LANDING_SITE_URL}/`).href) ||
    !body.includes(new URL("/en/faq/", `${LANDING_SITE_URL}/`).href)
  )
    throw new Error("landing llms index does not expose canonical topic routes");
}

function assertLandingDemoSubmission(response, body, state) {
  const expected =
    state === "enabled"
      ? { status: 400, code: "invalid_request" }
      : { status: 404, code: "submission_disabled" };
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`landing demo submission did not return ${expected.code}`);
  }
  if (
    response.status !== expected.status ||
    !/application\/json/i.test(response.headers.get("content-type") || "") ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.code !== expected.code
  )
    throw new Error(`landing demo submission did not return ${expected.code}`);
}

function parseManifest(body, baseUrl) {
  let manifest;
  try {
    manifest = JSON.parse(body);
  } catch {
    throw new Error("kiosk manifest is not valid JSON");
  }
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    typeof manifest.short_name !== "string" ||
    !manifest.short_name.trim() ||
    manifest.id !== "/" ||
    manifest.start_url !== "/" ||
    manifest.scope !== "/" ||
    !["fullscreen", "standalone", "minimal-ui"].includes(manifest.display) ||
    !Array.isArray(manifest.icons) ||
    manifest.icons.length === 0
  )
    throw new Error("kiosk manifest is not root-scoped and installable");
  for (const icon of manifest.icons) {
    if (
      icon === null ||
      typeof icon !== "object" ||
      Array.isArray(icon) ||
      typeof icon.sizes !== "string" ||
      !/^\d+x\d+$/.test(icon.sizes) ||
      typeof icon.type !== "string" ||
      !icon.type.startsWith("image/")
    )
      throw new Error("kiosk manifest icon is invalid");
    sameOriginPath(icon.src, baseUrl, "kiosk manifest icon");
  }
  return manifest;
}

function serviceWorkerPath(registration, baseUrl) {
  const match = registration.match(/\bserviceWorker\.register\(\s*["']([^"']+)["']/);
  const scope = registration.match(/\bscope\s*:\s*["']([^"']+)["']/)?.[1];
  if (!match || scope !== "/") throw new Error("kiosk service worker is not root-scoped");
  return sameOriginPath(match[1], baseUrl, "kiosk service worker");
}

function assertServiceWorker(body) {
  const compact = body.replace(/\s+/g, "");
  if (!compact.includes("precacheAndRoute(") || !compact.includes("NavigationRoute("))
    throw new Error("kiosk service worker does not provide the offline shell");
  if (!compact.includes("denylist:[/^\\/(?:api|station|kiosk)(?:\\/|$)/]"))
    throw new Error("kiosk service worker navigation fallback includes reserved paths");
  if ((body.match(/\bregisterRoute\(/g) || []).length !== 1)
    throw new Error("kiosk service worker has unexpected runtime caching");
  if (/\burl\s*:\s*["'][^"']*\/api\//i.test(body))
    throw new Error("kiosk service worker precaches an API path");
}

function scriptElements(html) {
  const lower = html.toLowerCase();
  const elements = [];
  let cursor = 0;

  while (cursor < html.length) {
    const opening = lower.indexOf("<script", cursor);
    if (opening === -1) break;
    const openingBoundary = lower[opening + "<script".length];
    if (openingBoundary !== ">" && !/\s/.test(openingBoundary ?? "")) {
      cursor = opening + "<script".length;
      continue;
    }
    const openingEnd = lower.indexOf(">", opening + "<script".length);
    if (openingEnd === -1) throw new Error("docs contains an unclosed script tag");

    let closing = lower.indexOf("</script", openingEnd + 1);
    let closingEnd = -1;
    while (closing !== -1) {
      closingEnd = closing + "</script".length;
      while (/\s/.test(lower[closingEnd] ?? "")) closingEnd += 1;
      if (lower[closingEnd] === ">") break;
      closing = lower.indexOf("</script", closing + "</script".length);
    }
    if (closing === -1) throw new Error("docs contains an unclosed script element");

    elements.push({
      attributes: html.slice(opening + "<script".length, openingEnd),
      body: html.slice(openingEnd + 1, closing),
    });
    cursor = closingEnd + 1;
  }

  return elements;
}

function documentationScripts(html, baseUrl) {
  const scripts = scriptElements(html).map(({ attributes, body }) => {
    if (body.trim()) throw new Error("docs contains an inline script");
    const source = attributes.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!source) throw new Error("docs contains an inline script");
    if (source.startsWith("//")) throw new Error("docs contains an external origin");
    const url = new URL(source, baseUrl);
    if (url.origin !== new URL(baseUrl).origin) throw new Error("docs contains an external origin");
    return url;
  });
  const paths = scripts.map((url) => url.pathname);
  if (paths.length !== 2 || paths[0] !== "/docs/scalar.js" || paths[1] !== "/docs/bootstrap.js")
    throw new Error("docs does not load the required same-origin scripts");
  return scripts;
}

async function assertDocumentation(client, html, baseUrl) {
  assertNoExternalOrigins(html, baseUrl);
  for (const url of documentationScripts(html, baseUrl)) {
    const response = await publicRequest(client, url, { method: "GET" });
    const body = await getText(response);
    assertHeaders(response, new URL(baseUrl).protocol === "https:", `admin ${url.pathname}`);
    if (
      response.status !== 200 ||
      !/(?:application|text)\/javascript/i.test(response.headers.get("content-type") || "")
    )
      throw new Error(`${url.pathname} did not return JavaScript`);
    if (!body.trim()) throw new Error(`${url.pathname} returned an empty script`);
    if (
      url.pathname === "/docs/scalar.js" &&
      !/window\.Scalar\s*=\s*\{\s*createApiReference\s*:/.test(body)
    )
      throw new Error("Scalar browser global is unavailable");
    if (url.pathname === "/docs/scalar.js" && body.includes("Function(``)"))
      throw new Error("Scalar browser bundle retains dynamic code evaluation");
    if (url.pathname === "/docs/bootstrap.js") {
      if (!/\burl\s*:\s*["']\/openapi\.json["']/.test(body))
        throw new Error("docs bootstrap does not target /openapi.json");
      const safeScalarConfiguration = [
        /\btelemetry\s*:\s*false\b/,
        /\bwithDefaultFonts\s*:\s*false\b/,
        /\bhideClientButton\s*:\s*true\b/,
        /\bhideTestRequestButton\s*:\s*true\b/,
        /\bshowDeveloperTools\s*:\s*["']never["']/,
        /\bagent\s*:\s*\{\s*disabled\s*:\s*true\s*\}/,
        /\bmcp\s*:\s*\{\s*disabled\s*:\s*true\s*\}/,
      ];
      if (
        safeScalarConfiguration.some((setting) => !setting.test(body)) ||
        /\bshowToolbar\s*:/.test(body)
      )
        throw new Error("docs bootstrap does not use the safe Scalar configuration");
    }
  }
}

async function getText(response) {
  return response.text();
}

async function publicRequest(client, url, init) {
  const signal = AbortSignal.timeout(5_000);
  return client.request(url, init, signal);
}

function assertRoute(check, response, body, signature) {
  const candidateSignature = shellSignature(body);
  const isShell = Boolean(
    signature &&
    candidateSignature &&
    candidateSignature.title === signature.title &&
    candidateSignature.modulePath === signature.modulePath,
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
  if (check.kind === "station-proxy") {
    if (
      ![200, 401, 403, 404].includes(response.status) ||
      !/application\/json/i.test(response.headers.get("content-type") || "")
    )
      throw new Error("station bootstrap did not return an upstream JSON response");
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("station bootstrap did not return valid JSON");
    }
    if (
      response.status === 404 &&
      (payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        Object.getPrototypeOf(payload) !== Object.prototype ||
        !Object.hasOwn(payload, "statusCode") ||
        !Object.hasOwn(payload, "message") ||
        !Object.hasOwn(payload, "error") ||
        Object.keys(payload).length !== 3 ||
        payload.statusCode !== 404 ||
        payload.message !== "Cannot GET /station/bootstrap" ||
        payload.error !== "Not Found")
    )
      throw new Error("station bootstrap did not return the exact Nest 11 JSON 404");
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
    check.kind === "docs" &&
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
  if (
    check.kind === "not-found" &&
    (response.status !== 404 ||
      /<html/i.test(body) ||
      /text\/html/i.test(response.headers.get("content-type") || ""))
  )
    throw new Error("unknown POST must be a non-HTML 404");
}

function assertKioskRoute(check, response, body, signature, manifest, baseUrl) {
  const [method, path, kind] = check;
  const candidateSignature = kioskShellSignature(body, baseUrl);
  const isShell = Boolean(
    candidateSignature &&
    candidateSignature.title === signature.title &&
    candidateSignature.modulePath === signature.modulePath,
  );
  if (kind !== "kiosk-shell" && isShell) throw new Error(`${path} returned the kiosk shell`);
  if (kind === "kiosk-shell") {
    if (
      response.status !== 200 ||
      !/text\/html/i.test(response.headers.get("content-type") || "") ||
      !isShell
    )
      throw new Error("kiosk root did not return the built kiosk shell");
    if (response.headers.get("cache-control") !== "no-cache")
      throw new Error("kiosk root must be no-cache");
  }
  if (
    kind === "asset" &&
    (response.status !== 200 ||
      response.headers.get("cache-control") !== "public, max-age=31536000, immutable")
  )
    throw new Error("kiosk asset cache contract failed");
  if (
    kind === "manifest" &&
    (response.status !== 200 ||
      !/(?:application\/manifest\+json|application\/json)/i.test(
        response.headers.get("content-type") || "",
      ) ||
      manifest === null)
  )
    throw new Error("kiosk manifest response is invalid");
  if (kind === "service-worker") {
    if (
      response.status !== 200 ||
      !/(?:application|text)\/javascript/i.test(response.headers.get("content-type") || "")
    )
      throw new Error("kiosk service worker response is invalid");
    assertServiceWorker(body);
  }
  if (kind === "kiosk-proxy") {
    if (
      ![200, 401, 403].includes(response.status) ||
      !/application\/json/i.test(response.headers.get("content-type") || "")
    )
      throw new Error("kiosk bootstrap did not return an upstream JSON response");
    try {
      JSON.parse(body);
    } catch {
      throw new Error("kiosk bootstrap did not return valid JSON");
    }
  }
  if (
    kind === "not-found" &&
    (response.status !== 404 ||
      /<html/i.test(body) ||
      /text\/html/i.test(response.headers.get("content-type") || ""))
  )
    throw new Error(`${method} ${path} must be a non-HTML 404 on the kiosk authority`);
}

async function runDocker(docker, args, commandTimeoutMs) {
  try {
    const result = docker.run("docker", args);
    return docker.handlesDeadline
      ? await result
      : await withDeadline(result, "docker", commandTimeoutMs);
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
  const compose = productionComposeArgs(environment, { includeCiOverlay: true });
  const apiId = await runDocker(docker, [...compose, "ps", "-q", "api"], options.commandTimeoutMs);
  const containerId = apiId.stdout.trim();
  if (apiId.code !== 0 || !containerId) throw new Error("API container ID is unavailable");
  const ports = await runDocker(
    docker,
    ["inspect", "--format", "{{json .HostConfig.PortBindings}}", containerId],
    options.commandTimeoutMs,
  );
  if (ports.code !== 0 || !ports.stdout.trim()) throw new Error("API port inspection failed");
  let bindings;
  try {
    bindings = JSON.parse(ports.stdout);
  } catch {
    throw new Error("API port inspection failed");
  }
  if (bindings !== null && (typeof bindings !== "object" || Array.isArray(bindings)))
    throw new Error("API port inspection failed");
  if (bindings !== null && Object.values(bindings).some((value) => value !== null))
    throw new Error("API is published on the host");
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
  if (environment.SMOKE_ASSERT_DEPENDENCY_ISOLATION === "1") {
    const dependencyIsolation = await runDocker(
      docker,
      [
        ...compose,
        "exec",
        "-T",
        "api",
        "node",
        "--input-type=module",
        "--eval",
        RUNTIME_DEPENDENCY_PROBE_SOURCE,
        "/app/node_modules",
      ],
      options.commandTimeoutMs,
    );
    if (dependencyIsolation.code === 1)
      throw new Error("API runtime contains a forbidden tooling or telemetry dependency");
    if (dependencyIsolation.code !== 0) throw new Error("API runtime dependency scan failed");
  }

  if (environment.SMOKE_ASSERT_SHUTDOWN !== "1") return;
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
    const inspected = await runDocker(
      docker,
      ["inspect", "--format", "{{json .State}}", containerId],
      options.commandTimeoutMs,
    );
    let state;
    try {
      state = JSON.parse(inspected.stdout);
    } catch {
      throw new Error("API did not stop cleanly");
    }
    if (
      inspected.code !== 0 ||
      state === null ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      state.Status !== "exited" ||
      state.ExitCode !== 0 ||
      state.OOMKilled !== false ||
      state.Error !== ""
    )
      throw new Error("API did not stop cleanly");
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
    if (restoreError)
      throw new AggregateError(
        [stopError, restoreError],
        `API shutdown failed: ${stopError.message}; restoration failed: ${restoreError.message}`,
      );
    throw stopError;
  }
  if (restoreError) throw restoreError;
}

async function runAdminSmoke(options, client) {
  const baseUrl = options.adminBaseUrl.replace(/\/$/, "");
  const root = await publicRequest(client, new URL("/", baseUrl), { method: "GET" });
  if (
    options.expectedReleaseSha &&
    root.headers.get("x-markiro-release-sha") !== options.expectedReleaseSha
  )
    throw new Error("live release identity does not match the expected release");
  const rootHtml = await getText(root);
  assertHeaders(root, new URL(baseUrl).protocol === "https:", "admin /");
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
    assertHeaders(response, new URL(baseUrl).protocol === "https:", `admin ${path}`);
    assertRoute(check, response, body, signature);
    if (check.kind === "docs") await assertDocumentation(client, body, baseUrl);
  }
  return {
    releaseSha: root.headers.get("x-markiro-release-sha"),
    signature,
  };
}

async function runSaasAdminSmoke(options, client, admin) {
  const baseUrl = options.saasAdminBaseUrl.replace(/\/$/, "");
  const root = await publicRequest(client, new URL("/", baseUrl), { method: "GET" });
  if (
    options.expectedReleaseSha &&
    root.headers.get("x-markiro-release-sha") !== options.expectedReleaseSha
  )
    throw new Error("live release identity does not match the expected release");
  const rootHtml = await getText(root);
  assertHeaders(root, new URL(baseUrl).protocol === "https:", "SaaS admin /");
  const signature = shellSignature(rootHtml);
  if (root.status !== 200 || !signature)
    throw new Error("SaaS admin root did not return the built platform shell");
  if (
    signature.title === admin.signature.title &&
    signature.modulePath === admin.signature.modulePath
  )
    throw new Error("SaaS admin root returned the customer admin shell");
  assertNoExternalOrigins(rootHtml, baseUrl);

  for (const [method, contractPath, kind] of SAAS_ADMIN_ROUTE_CHECKS) {
    const path = contractPath.replace(
      "${assetName}",
      options.saasAdminAssetName || signature.modulePath.slice("/assets/".length),
    );
    const response =
      contractPath === "/" ? root : await publicRequest(client, new URL(path, baseUrl), { method });
    const body = contractPath === "/" ? rootHtml : await getText(response);
    assertHeaders(response, new URL(baseUrl).protocol === "https:", `SaaS admin ${path}`);
    const contentType = response.headers.get("content-type") || "";
    if (kind === "saas-shell") {
      if (response.status !== 200 || !shellSignature(body))
        throw new Error(`SaaS admin ${path} did not return the platform shell`);
      continue;
    }
    if (kind === "asset") {
      if (response.status !== 200 || /text\/html/i.test(contentType))
        throw new Error("SaaS admin asset is unavailable");
      continue;
    }
    if (kind === "platform-proxy") {
      if (response.status >= 500 || /text\/html/i.test(contentType))
        throw new Error(`SaaS admin ${path} did not reach the platform API`);
      continue;
    }
    if (response.status !== 404 || /text\/html/i.test(contentType))
      throw new Error(`SaaS admin ${path} did not return a plain 404`);
  }

  return { releaseSha: root.headers.get("x-markiro-release-sha") };
}

async function runKioskSmoke(options, client, admin) {
  const baseUrl = options.kioskBaseUrl.replace(/\/$/, "");
  const root = await publicRequest(client, new URL("/", baseUrl), { method: "GET" });
  if (
    options.expectedReleaseSha &&
    root.headers.get("x-markiro-release-sha") !== options.expectedReleaseSha
  )
    throw new Error("live release identity does not match the expected release");
  const rootHtml = await getText(root);
  assertHeaders(root, new URL(baseUrl).protocol === "https:", "kiosk /");
  const signature = kioskShellSignature(rootHtml, baseUrl);
  if (root.status !== 200 || !signature)
    throw new Error("kiosk root did not return the built kiosk shell");
  if (
    signature.title === admin.signature.title &&
    signature.modulePath === admin.signature.modulePath
  )
    throw new Error("kiosk root returned the admin shell");
  assertNoExternalOrigins(rootHtml, baseUrl);
  if (signature.manifestPath !== "/manifest.webmanifest")
    throw new Error("kiosk shell does not use the root manifest");

  const registrationResponse = await publicRequest(
    client,
    new URL(signature.registrationPath, baseUrl),
    { method: "GET" },
  );
  const registration = await getText(registrationResponse);
  assertHeaders(
    registrationResponse,
    new URL(baseUrl).protocol === "https:",
    `kiosk ${signature.registrationPath}`,
  );
  if (
    registrationResponse.status !== 200 ||
    !/(?:application|text)\/javascript/i.test(
      registrationResponse.headers.get("content-type") || "",
    )
  )
    throw new Error("kiosk service-worker registration is unavailable");
  const discoveredServiceWorkerPath = serviceWorkerPath(registration, baseUrl);
  const serviceWorkerContract = KIOSK_ROUTE_CHECKS.find(([, , kind]) => kind === "service-worker");
  if (discoveredServiceWorkerPath !== serviceWorkerContract[1])
    throw new Error("kiosk service-worker artifact does not match the built registration");

  let manifest = null;
  for (const check of KIOSK_ROUTE_CHECKS) {
    const [method, contractPath, kind] = check;
    const path = contractPath.replace(
      "${assetName}",
      options.kioskAssetName || signature.modulePath.slice("/assets/".length),
    );
    const response =
      contractPath === "/" ? root : await publicRequest(client, new URL(path, baseUrl), { method });
    const body = contractPath === "/" ? rootHtml : await getText(response);
    assertHeaders(response, new URL(baseUrl).protocol === "https:", `kiosk ${path}`);
    if (kind === "manifest") manifest = parseManifest(body, baseUrl);
    assertKioskRoute(check, response, body, signature, manifest, baseUrl);
  }
  return { releaseSha: root.headers.get("x-markiro-release-sha") };
}

async function runLandingSmoke(options, client) {
  const baseUrl = options.landingBaseUrl.replace(/\/$/, "");
  const root = await publicRequest(client, new URL("/", baseUrl), { method: "GET" });
  if (
    options.expectedReleaseSha &&
    root.headers.get("x-markiro-release-sha") !== options.expectedReleaseSha
  )
    throw new Error("live release identity does not match the expected release");
  const rootBody = await getText(root);
  assertHeaders(root, new URL(baseUrl).protocol === "https:", "landing /", LANDING_CSP);

  for (const check of LANDING_ROUTE_CHECKS) {
    const [method, path] = check;
    const requestOptions = {
      method,
      ...(path.startsWith("/d/") ? { redirect: "manual" } : {}),
    };
    const response =
      path === "/" ? root : await publicRequest(client, new URL(path, baseUrl), requestOptions);
    const body = path === "/" ? rootBody : await getText(response);
    assertHeaders(response, new URL(baseUrl).protocol === "https:", `landing ${path}`, LANDING_CSP);
    assertLandingRoute(check, response, body, baseUrl, options.landingDemoSubmissionState);
  }
  const manifestResponse = await publicRequest(client, new URL("/legal/artifacts.json", baseUrl), {
    method: "GET",
  });
  assertHeaders(
    manifestResponse,
    new URL(baseUrl).protocol === "https:",
    "landing /legal/artifacts.json",
    LANDING_CSP,
  );
  if (
    manifestResponse.status !== 200 ||
    !/application\/json/i.test(manifestResponse.headers.get("content-type") || "")
  )
    throw new Error("landing legal artifact manifest is unavailable");
  let artifacts;
  try {
    artifacts = JSON.parse(await getText(manifestResponse));
  } catch {
    throw new Error("landing legal artifact manifest is invalid");
  }
  if (!Array.isArray(artifacts)) throw new Error("landing legal artifact manifest is invalid");
  const artifact = artifacts.find(
    (candidate) =>
      candidate?.code === "MKR-PD-01" && candidate.locale === "ru" && candidate.kind === "pdfa-2b",
  );
  if (
    artifact === undefined ||
    typeof artifact.fileName !== "string" ||
    !/^markiro_[a-z0-9._-]+\.pdf$/.test(artifact.fileName) ||
    !Number.isSafeInteger(artifact.bytes) ||
    artifact.bytes <= 0 ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
    artifact.mediaType !== "application/pdf"
  )
    throw new Error("landing legal PDF manifest entry is invalid");
  const pdfResponse = await publicRequest(
    client,
    new URL(`/legal/files/${artifact.fileName}`, baseUrl),
    { method: "GET" },
  );
  assertHeaders(
    pdfResponse,
    new URL(baseUrl).protocol === "https:",
    `landing /legal/files/${artifact.fileName}`,
    LANDING_CSP,
  );
  if (
    pdfResponse.status !== 200 ||
    !/application\/pdf/i.test(pdfResponse.headers.get("content-type") || "")
  )
    throw new Error("landing legal PDF is unavailable");
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
  if (
    pdfBytes.byteLength !== artifact.bytes ||
    createHash("sha256").update(pdfBytes).digest("hex") !== artifact.sha256
  )
    throw new Error("landing legal PDF does not match its manifest");
  const demoSubmission = await publicRequest(client, new URL("/api/demo-requests", baseUrl), {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  const demoSubmissionBody = await getText(demoSubmission);
  assertHeaders(
    demoSubmission,
    new URL(baseUrl).protocol === "https:",
    "landing POST /api/demo-requests",
    LANDING_CSP,
  );
  assertLandingDemoSubmission(
    demoSubmission,
    demoSubmissionBody,
    options.landingDemoSubmissionState,
  );
  return { releaseSha: root.headers.get("x-markiro-release-sha") };
}

/**
 * Run the shared v-b route assertions through an injectable request client.
 * The caller owns transport; this function always asserts the logical v-b authorities.
 */
export async function runVbtechSmoke(options, client = requestClient()) {
  const baseUrl = options.vbtechBaseUrl.replace(/\/$/, "");
  const wwwBaseUrl = options.vbtechWwwBaseUrl.replace(/\/$/, "");
  const releaseSha = options.expectedVbtechReleaseSha;
  if (typeof releaseSha !== "string" || !/^[0-9a-f]{40}$/.test(releaseSha))
    throw new Error("v-b release identity is invalid");
  const submissionState = vbtechSubmissionState(options.vbtechSubmissionState);
  const requiresHsts = new URL(baseUrl).protocol === "https:";

  for (const [method, path, kind] of VBTECH_ROUTE_CHECKS) {
    const response = await publicRequest(client, new URL(path, baseUrl), {
      method,
      ...(method === "POST" ? { body: "{}", headers: { "content-type": "application/json" } } : {}),
    });
    const body = await getText(response);
    assertVbtechHeaders(response, requiresHsts, `v-b ${method} ${path}`, releaseSha);
    const contentType = response.headers.get("content-type") || "";

    if (kind === "vbtech-page") {
      if (
        response.status !== 200 ||
        !/text\/html/i.test(contentType) ||
        !body.includes(`meta name="vbtech-release-sha" content="${releaseSha}"`) ||
        !/<html\b[^>]*\bdata-theme=/i.test(body)
      )
        throw new Error(`v-b ${path} is not the expected release page`);
      continue;
    }
    if (kind === "vbtech-not-found") {
      if (response.status !== 404 || !/text\/html/i.test(contentType))
        throw new Error(`v-b ${path} did not return the branded 404`);
      continue;
    }
    if (kind === "not-found") {
      if (response.status !== 404 || /text\/html/i.test(contentType))
        throw new Error(`v-b ${method} ${path} did not return a plain 404`);
      continue;
    }
    const expectedStatus = submissionState === "enabled" ? 400 : 404;
    if (kind !== "contact-state" || response.status !== expectedStatus)
      throw new Error(`v-b POST /api/contact does not match the configured state`);
  }

  const canonicalPath = "/canonical-check";
  const redirect = await publicRequest(client, new URL(canonicalPath, wwwBaseUrl), {
    method: "GET",
    redirect: "manual",
  });
  assertVbtechHeaders(
    redirect,
    new URL(wwwBaseUrl).protocol === "https:",
    "v-b canonical redirect",
    releaseSha,
  );
  if (
    ![301, 308].includes(redirect.status) ||
    redirect.headers.get("location") !== new URL(canonicalPath, baseUrl).href
  )
    throw new Error("v-b www authority is not canonical");
}

export async function runPublicSmoke(options, client = requestClient()) {
  const landingState = landingDemoSubmissionState(options.landingDemoSubmissionState ?? "disabled");
  const smokeOptions = { ...options, landingDemoSubmissionState: landingState };
  const admin = await runAdminSmoke(smokeOptions, client);
  const saasAdmin = options.saasAdminBaseUrl
    ? await runSaasAdminSmoke(smokeOptions, client, admin)
    : undefined;
  const kiosk = await runKioskSmoke(smokeOptions, client, admin);
  const landing = await runLandingSmoke(smokeOptions, client);
  if (options.vbtechBaseUrl) await runVbtechSmoke(options, client);
  if (
    !options.expectedReleaseSha &&
    (admin.releaseSha || saasAdmin?.releaseSha || kiosk.releaseSha || landing.releaseSha)
  ) {
    if (
      !admin.releaseSha ||
      (saasAdmin && admin.releaseSha !== saasAdmin.releaseSha) ||
      admin.releaseSha !== kiosk.releaseSha ||
      admin.releaseSha !== landing.releaseSha
    )
      throw new Error("live authorities do not serve the same release");
  }
}

/**
 * @param {{adminBaseUrl: string, saasAdminBaseUrl?: string, kioskBaseUrl: string, landingBaseUrl: string, vbtechBaseUrl?: string, vbtechWwwBaseUrl?: string, assetName?: string, saasAdminAssetName?: string, kioskAssetName?: string, expectedReleaseSha?: string, expectedVbtechReleaseSha?: string, vbtechSubmissionState?: "disabled" | "enabled", environment?: Record<string, string | undefined>, commandTimeoutMs?: number, readinessAttempts?: number, readinessIntervalMs?: number, sleep?: (milliseconds: number) => Promise<void>}} options
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
  await runPublicSmoke(options, client);
  const baseUrl = options.adminBaseUrl.replace(/\/$/, "");
  await runtimeSmoke(environment, dockerClient, client, baseUrl, runtimeOptions);
}

if (isMainModule(import.meta.url)) {
  try {
    const { admin, saasAdmin, kiosk, landing } = productionBaseUrls(process.env);
    await runSmoke({
      adminBaseUrl: admin,
      saasAdminBaseUrl: saasAdmin,
      kioskBaseUrl: kiosk,
      landingBaseUrl: landing,
      expectedReleaseSha: process.env.MARKIRO_IMAGE_TAG,
      landingDemoSubmissionState: landingDemoSubmissionState(
        process.env.MARKIRO_LANDING_DEMO_SUBMISSION_STATE,
      ),
      environment: process.env,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
