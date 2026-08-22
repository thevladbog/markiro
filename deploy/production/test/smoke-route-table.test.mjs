import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  KIOSK_ROUTE_CHECKS,
  LANDING_ROUTE_CHECKS,
  productionBaseUrls,
  ROUTE_CHECKS,
  VBTECH_ROUTE_CHECKS,
  runPublicSmoke,
  runSmoke,
  runVbtechSmoke,
} from "../smoke.mjs";

const csp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob: https://storage.yandexcloud.net; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const landingCsp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://smartcaptcha.cloud.yandex.ru; frame-src 'self' https://smartcaptcha.cloud.yandex.ru; connect-src 'self' https://smartcaptcha.cloud.yandex.ru; worker-src 'self' blob:; manifest-src 'self'";
const shell =
  '<html><head><title>Markiro</title><script type="module" src="/assets/main.js"></script></head><body></body></html>';
const saasAdminShell =
  '<html><head><title>Markiro Platform</title><script type="module" src="/assets/saas.js"></script></head><body></body></html>';
const kioskShell =
  '<html lang="ru"><head><title>Маркиро — Киоск</title><script type="module" src="/assets/kiosk.js"></script><link rel="manifest" href="/manifest.webmanifest"><script id="vite-plugin-pwa:register-sw" src="/registerSW.js" defer></script></head><body><div id="root"></div></body></html>';
const kioskManifest = JSON.stringify({
  id: "/",
  name: "Маркиро — Киоск",
  short_name: "Киоск",
  start_url: "/",
  scope: "/",
  display: "fullscreen",
  icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
});
const kioskRegistration =
  "if('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' });";
const kioskServiceWorker =
  'precacheAndRoute([{url:"index.html",revision:"1"}],{});cleanupOutdatedCaches();registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"),{denylist:[/^\\/(?:api|station|kiosk)(?:\\/|$)/]}));';
const landingShell = (path = "/") =>
  `<!doctype html><html lang="ru"><head><title>Маркировка Честный знак — Markiro</title><link rel="canonical" href="https://markiro.app${path}"></head><body><main><h1>Маркировка без остановки производства</h1></main></body></html>`;
const landingNotFoundShell =
  '<!doctype html><html lang="ru"><head><title>Страница не найдена / Page not found — Markiro</title></head><body><main><h1>Редакция не найдена<br><span>Revision not found</span></h1><a href="/legal/">Document registry</a></main></body></html>';
const landingRobots = `User-agent: *
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: Claude-SearchBot
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: GPTBot
Disallow: /
User-agent: ClaudeBot
Disallow: /
Sitemap: https://markiro.app/sitemap.xml
`;
const landingSitemap =
  '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://markiro.app/</loc></url><url><loc>https://markiro.app/faq/</loc></url><url><loc>https://markiro.app/en/</loc></url><url><loc>https://markiro.app/en/faq/</loc></url></urlset>';
const landingLlms =
  "# Markiro\n\n- [Главная](https://markiro.app/)\n- [Вопросы и ответы](https://markiro.app/faq/)\n- [Home](https://markiro.app/en/)\n- [Questions](https://markiro.app/en/faq/)\n";
const legalPdf = "%PDF-1.7\nvalidated-pdfa-2b-test-fixture\n%%EOF\n";
const legalPdfSha256 = createHash("sha256").update(legalPdf).digest("hex");
const legalPdfFileName = "markiro_mkr-pd-01_2026.08-01_ru.pdf";
const legalArtifacts = JSON.stringify([
  {
    code: "MKR-PD-01",
    revision: "2026.08/01",
    effectiveDate: "2026-08-15",
    locale: "ru",
    kind: "pdfa-2b",
    fileName: legalPdfFileName,
    bytes: Buffer.byteLength(legalPdf),
    sha256: legalPdfSha256,
    mediaType: "application/pdf",
    generator: { docx: "9.7.1", libreOffice: "26.2.5", veraPdf: "1.30.2" },
  },
]);
const docsShell =
  '<!doctype html><html><head><title>API docs</title></head><body><div id="app"></div><script src="/docs/scalar.js"></script ><script src="/docs/bootstrap.js"></script   ></body></html>';
const docsBootstrap = `Scalar.createApiReference("#app", {
  url: "/openapi.json",
  telemetry: false,
  withDefaultFonts: false,
  hideClientButton: true,
  hideTestRequestButton: true,
  showDeveloperTools: "never",
  agent: { disabled: true },
  mcp: { disabled: true }
});`;

test("uses the configured HTTPS port for production-bundle smoke", () => {
  assert.deepEqual(
    productionBaseUrls({
      MARKIRO_DOMAIN: "localhost",
      MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.localhost",
      MARKIRO_KIOSK_DOMAIN: "kiosk.localhost",
      MARKIRO_LANDING_DOMAIN: "landing.localhost",
      MARKIRO_HTTPS_PORT: "18443",
    }),
    {
      admin: "https://localhost:18443",
      saasAdmin: "https://saas-admin.localhost:18443",
      kiosk: "https://kiosk.localhost:18443",
      landing: "https://landing.localhost:18443",
    },
  );
  assert.deepEqual(
    productionBaseUrls({
      MARKIRO_DOMAIN: "admin.markiro.example",
      MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
      MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
      MARKIRO_LANDING_DOMAIN: "markiro.example",
    }),
    {
      admin: "https://admin.markiro.example",
      saasAdmin: "https://saas-admin.markiro.example",
      kiosk: "https://kiosk.markiro.example",
      landing: "https://markiro.example",
    },
  );
});

test("activates v-b smoke authorities only for the exact digest selector and ignores retired inputs", () => {
  const markiroEnvironment = {
    MARKIRO_DOMAIN: "admin.markiro.example",
    MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
    MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
    MARKIRO_LANDING_DOMAIN: "markiro.example",
  };
  const markiroUrls = {
    admin: "https://admin.markiro.example",
    saasAdmin: "https://saas-admin.markiro.example",
    kiosk: "https://kiosk.markiro.example",
    landing: "https://markiro.example",
  };

  assert.deepEqual(
    productionBaseUrls({
      ...markiroEnvironment,
      VBTECH_IMAGE_TAG: `ghcr.io/thevladbog/vbtech-web:${"c".repeat(40)}`,
    }),
    markiroUrls,
  );
  assert.deepEqual(
    productionBaseUrls({
      ...markiroEnvironment,
      VBTECH_DOMAIN: "v-b.tech",
      VBTECH_WWW_DOMAIN: "www.v-b.tech",
    }),
    markiroUrls,
  );
  assert.deepEqual(
    productionBaseUrls({
      ...markiroEnvironment,
      VBTECH_IMAGE_REF: `ghcr.io/thevladbog/vbtech-web@sha256:${"d".repeat(64)}`,
      VBTECH_DOMAIN: "v-b.tech",
      VBTECH_WWW_DOMAIN: "www.v-b.tech",
    }),
    {
      ...markiroUrls,
      vbtech: "https://v-b.tech",
      vbtechWww: "https://www.v-b.tech",
    },
  );
});

test("rejects malformed and equal smoke authorities without disclosing their values", () => {
  const cases = [
    [
      {
        MARKIRO_DOMAIN: "markiro.example@evil.example",
        MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
        MARKIRO_LANDING_DOMAIN: "landing.markiro.example",
      },
      "MARKIRO_DOMAIN is invalid",
      "evil.example",
    ],
    [
      {
        MARKIRO_DOMAIN: "markiro.example",
        MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example/private",
        MARKIRO_LANDING_DOMAIN: "landing.markiro.example",
      },
      "MARKIRO_KIOSK_DOMAIN is invalid",
      "private",
    ],
    [
      {
        MARKIRO_DOMAIN: "markiro.example",
        MARKIRO_KIOSK_DOMAIN: "markiro.example",
        MARKIRO_LANDING_DOMAIN: "landing.markiro.example",
      },
      "production domains must be distinct",
      "markiro.example",
    ],
    [
      {
        MARKIRO_DOMAIN: "localhost",
        MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
        MARKIRO_LANDING_DOMAIN: "landing.markiro.example",
      },
      "MARKIRO_DOMAIN is invalid",
      "kiosk.markiro.example",
    ],
    [
      {
        MARKIRO_DOMAIN: "markiro.example",
        MARKIRO_KIOSK_DOMAIN: "kiosk.localhost",
        MARKIRO_LANDING_DOMAIN: "landing.markiro.example",
      },
      "MARKIRO_KIOSK_DOMAIN is invalid",
      "markiro.example",
    ],
    [
      {
        MARKIRO_DOMAIN: "admin.markiro.example",
        MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
        MARKIRO_LANDING_DOMAIN: "https://markiro.example",
      },
      "MARKIRO_LANDING_DOMAIN is invalid",
      "https://markiro.example",
    ],
    [
      {
        MARKIRO_DOMAIN: "admin.markiro.example",
        MARKIRO_KIOSK_DOMAIN: "kiosk.markiro.example",
        MARKIRO_LANDING_DOMAIN: "admin.markiro.example",
      },
      "production domains must be distinct",
      "admin.markiro.example",
    ],
  ];

  for (const [environment, message, privateValue] of cases) {
    assert.throws(
      () =>
        productionBaseUrls({
          MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.example",
          ...environment,
        }),
      (error) => {
        assert.equal(error.message, message);
        assert.doesNotMatch(error.message, new RegExp(privateValue.replaceAll(".", "\\.")));
        return true;
      },
    );
  }
});

function response({ status = 200, body = "{}", headers = {}, cspPolicy = csp } = {}) {
  const bytes = Buffer.from(body);
  return {
    status,
    headers: new Headers({
      "content-security-policy": cspPolicy,
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...headers,
    }),
    text: async () => body,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function landingResponse(options = {}) {
  return response({ ...options, cspPolicy: landingCsp });
}

function vbtechResponse({ status = 200, body = "{}", headers = {} } = {}) {
  return response({
    status,
    body,
    cspPolicy:
      "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src https://smartcaptcha.cloud.yandex.ru; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline' https://smartcaptcha.cloud.yandex.ru; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests",
    headers: {
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "x-vbtech-release-sha": "c".repeat(40),
      ...headers,
    },
  });
}

function smokeClient(releaseSha, landingDemoSubmissionState = "disabled") {
  const requests = [];
  return {
    requests,
    async request(url, init) {
      requests.push({ url, init });
      const parsed = new URL(url);
      const path = parsed.pathname;
      const saasAdmin = parsed.hostname.startsWith("saas-admin.");
      const kiosk = parsed.hostname.startsWith("kiosk.");
      const landing = parsed.hostname === "markiro.example";
      if (saasAdmin && (path === "/" || path === "/login"))
        return response({
          body: saasAdminShell,
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/html",
            ...(releaseSha ? { "x-markiro-release-sha": releaseSha } : {}),
          },
        });
      if (saasAdmin && path === "/assets/saas.js")
        return response({
          body: "console.log('platform')",
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": "application/javascript",
          },
        });
      if (
        saasAdmin &&
        (path.startsWith("/api/platform-auth/") || path.startsWith("/api/platform/"))
      )
        return response({
          status: path.startsWith("/api/platform/") ? 401 : 200,
          body: path.startsWith("/api/platform/") ? '{"code":"unauthorized"}' : "null",
          headers: { "content-type": "application/json" },
        });
      if (saasAdmin)
        return response({
          status: 404,
          body: "not found",
          headers: { "content-type": "text/plain" },
        });
      if (
        landing &&
        [
          "/",
          "/faq/",
          "/en/",
          "/en/chestny-znak-serialization/",
          "/en/sscc-and-aggregation/",
          "/en/packing-workstation/",
          "/en/self-service-pickup-kiosk/",
          "/en/1c-integration/",
          "/en/offline-production/",
          "/en/faq/",
          "/legal/",
          "/privacy/",
          "/personal-data-consent/",
          "/d/MKR-PD-01/2026.08/01/15.08.2026",
        ].includes(path)
      )
        return landingResponse({
          body: landingShell(path),
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/html; charset=utf-8",
            ...(releaseSha ? { "x-markiro-release-sha": releaseSha } : {}),
          },
        });
      if (landing && path === "/robots.txt")
        return landingResponse({
          body: landingRobots,
          headers: {
            "cache-control": "public, max-age=300",
            "content-type": "text/plain; charset=utf-8",
          },
        });
      if (landing && path === "/sitemap.xml")
        return landingResponse({
          body: landingSitemap,
          headers: {
            "cache-control": "public, max-age=300",
            "content-type": "application/xml; charset=utf-8",
          },
        });
      if (landing && path === "/llms.txt")
        return landingResponse({
          body: landingLlms,
          headers: {
            "cache-control": "public, max-age=300",
            "content-type": "text/plain; charset=utf-8",
          },
        });
      if (landing && path === "/legal/artifacts.json")
        return landingResponse({
          body: legalArtifacts,
          headers: {
            "cache-control": "public, max-age=300",
            "content-type": "application/json; charset=utf-8",
          },
        });
      if (landing && path === `/legal/files/${legalPdfFileName}`)
        return landingResponse({
          body: legalPdf,
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": "application/pdf",
          },
        });
      if (landing && path === "/api/demo-requests" && (init?.method ?? "GET") === "POST")
        return landingResponse({
          status: landingDemoSubmissionState === "enabled" ? 400 : 404,
          body: JSON.stringify({
            code:
              landingDemoSubmissionState === "enabled" ? "invalid_request" : "submission_disabled",
          }),
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      if (landing && path === "/missing/")
        return landingResponse({
          status: 404,
          body: landingNotFoundShell,
          headers: { "cache-control": "no-cache", "content-type": "text/html; charset=utf-8" },
        });
      if (landing)
        return landingResponse({
          status: 404,
          body: "not found",
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      if (kiosk && path === "/")
        return response({
          body: kioskShell,
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/html",
            ...(releaseSha ? { "x-markiro-release-sha": releaseSha } : {}),
          },
        });
      if (kiosk && path === "/assets/kiosk.js")
        return response({
          body: "console.log('kiosk')",
          headers: {
            "cache-control": "public, max-age=31536000, immutable",
            "content-type": "application/javascript",
          },
        });
      if (kiosk && path === "/manifest.webmanifest")
        return response({
          body: kioskManifest,
          headers: { "content-type": "application/manifest+json" },
        });
      if (kiosk && path === "/registerSW.js")
        return response({
          body: kioskRegistration,
          headers: { "content-type": "application/javascript" },
        });
      if (kiosk && path === "/sw.js")
        return response({
          body: kioskServiceWorker,
          headers: { "content-type": "application/javascript" },
        });
      if (kiosk && path === "/api/kiosk/bootstrap")
        return response({
          body: '{"status":"ok"}',
          headers: { "content-type": "application/json" },
        });
      if (kiosk)
        return response({
          status: 404,
          body: "not found",
          headers: { "content-type": "text/plain" },
        });
      if (path === "/api/demo-requests")
        return response({
          status: 404,
          body: "not found",
          headers: { "content-type": "text/plain" },
        });
      if (path === "/" || path === "/team/deep-link")
        return response({
          body: shell,
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/html",
            ...(releaseSha ? { "x-markiro-release-sha": releaseSha } : {}),
          },
        });
      if (path === "/assets/main.js")
        return response({
          body: "console.log('ok')",
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        });
      if (path === "/health/ready" || path === "/api/health/ready")
        return response({
          body: '{"status":"degraded"}',
          headers: { "content-type": "application/json" },
        });
      if (path === "/docs")
        return response({
          body: docsShell,
          headers: { "content-type": "text/html" },
        });
      if (path === "/docs/scalar.js")
        return response({
          body: "window.Scalar={createApiReference:()=>{}}",
          headers: { "content-type": "application/javascript" },
        });
      if (path === "/docs/bootstrap.js")
        return response({
          body: docsBootstrap,
          headers: { "content-type": "application/javascript" },
        });
      if (path === "/unknown")
        return response({
          status: 404,
          body: "not found",
          headers: { "content-type": "text/plain" },
        });
      if (path === "/1c_exchange")
        return response({ body: "failure\n", headers: { "content-type": "text/plain" } });
      return response({ body: '{"status":"ok"}', headers: { "content-type": "application/json" } });
    },
  };
}

function smokeClientWithLandingScript(source, landingDemoSubmissionState) {
  const client = smokeClient(undefined, landingDemoSubmissionState);
  const original = client.request;
  client.request = (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "markiro.example" && parsed.pathname === "/") {
      return landingResponse({
        body: landingShell().replace("</head>", `<script src="${source}" defer></script></head>`),
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/html; charset=utf-8",
        },
      });
    }
    return original(url, init);
  };
  return client;
}

test("runner public smoke exercises the external route contract without local Docker access", async () => {
  const client = smokeClient();

  await runPublicSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      saasAdminBaseUrl: "https://saas-admin.markiro.example",
      kioskBaseUrl: "https://kiosk.markiro.example",
      landingBaseUrl: "https://markiro.example",
    },
    client,
  );

  assert.ok(client.requests.some(({ url }) => new URL(url).pathname === "/health/ready"));
  assert.ok(
    client.requests.some(
      ({ url }) =>
        new URL(url).hostname === "saas-admin.markiro.example" &&
        new URL(url).pathname === "/api/platform/catalog",
    ),
  );
  assert.ok(
    client.requests.some(
      ({ url }) =>
        new URL(url).hostname === "kiosk.markiro.example" &&
        new URL(url).pathname === "/api/kiosk/bootstrap",
    ),
  );
});

test("public smoke rejects demo-request proxy leakage on the admin authority", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = (url, init) => {
    if (
      new URL(url).hostname === "app.markiro.example" &&
      new URL(url).pathname === "/api/demo-requests" &&
      init?.method === "POST"
    )
      return response({
        body: '{"status":"proxied"}',
        headers: { "content-type": "application/json" },
      });
    return original(url, init);
  };

  await assert.rejects(
    runPublicSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.markiro.example",
        landingBaseUrl: "https://markiro.example",
      },
      client,
    ),
    /non-HTML 404/,
  );
});

test("landing smoke exercises the approved enabled API state without captcha or mail", async () => {
  const client = smokeClient(undefined, "enabled");

  await runPublicSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.markiro.example",
      landingBaseUrl: "https://markiro.example",
      landingDemoSubmissionState: "enabled",
    },
    client,
  );

  const submission = client.requests.find(
    ({ url, init }) =>
      new URL(url).hostname === "markiro.example" &&
      new URL(url).pathname === "/api/demo-requests" &&
      init?.method === "POST",
  );
  assert.equal(submission.init.body, "{}");
  assert.equal(submission.init.headers["content-type"], "application/json");
});

test("landing smoke allows SmartCaptcha runtime assets in enabled mode", async () => {
  const client = smokeClientWithLandingScript(
    "https://smartcaptcha.cloud.yandex.ru/captcha.js",
    "enabled",
  );

  await runPublicSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.markiro.example",
      landingBaseUrl: "https://markiro.example",
      landingDemoSubmissionState: "enabled",
    },
    client,
  );
});

test("landing smoke rejects unknown runtime origins in enabled mode", async () => {
  const client = smokeClientWithLandingScript("https://cdn.example/captcha.js", "enabled");

  await assert.rejects(
    runPublicSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.markiro.example",
        landingBaseUrl: "https://markiro.example",
        landingDemoSubmissionState: "enabled",
      },
      client,
    ),
    /external origin/,
  );
});

test("landing smoke rejects SmartCaptcha runtime assets in disabled mode", async () => {
  const client = smokeClientWithLandingScript(
    "https://smartcaptcha.cloud.yandex.ru/captcha.js",
    "disabled",
  );

  await assert.rejects(
    runPublicSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.markiro.example",
        landingBaseUrl: "https://markiro.example",
        landingDemoSubmissionState: "disabled",
      },
      client,
    ),
    /external origin/,
  );
});

test("landing smoke rejects the wrong disabled API error code", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = (url, init) => {
    if (
      new URL(url).hostname === "markiro.example" &&
      new URL(url).pathname === "/api/demo-requests" &&
      init?.method === "POST"
    )
      return landingResponse({
        status: 404,
        body: '{"code":"not_found"}',
        headers: { "content-type": "application/json" },
      });
    return original(url, init);
  };

  await assert.rejects(
    runPublicSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.markiro.example",
        landingBaseUrl: "https://markiro.example",
        landingDemoSubmissionState: "disabled",
      },
      client,
    ),
    /submission_disabled/,
  );
});

test("public smoke rejects a different live release identity before exercising routes", async () => {
  const client = smokeClient("b".repeat(40));

  await assert.rejects(
    runPublicSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.markiro.example",
        landingBaseUrl: "https://markiro.example",
        expectedReleaseSha: "a".repeat(40),
      },
      client,
    ),
    /live release identity does not match/,
  );

  assert.equal(client.requests.length, 1);
});

test("public smoke accepts the exact live release identity", async () => {
  const releaseSha = "a".repeat(40);
  const client = smokeClient(releaseSha);

  await runPublicSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.markiro.example",
      landingBaseUrl: "https://markiro.example",
      expectedReleaseSha: releaseSha,
    },
    client,
  );

  assert.ok(client.requests.length > 1);
});

test("landing smoke permits only the public canonical URL outside the deployment origin", async (t) => {
  for (const [name, mutate, expected] of [
    [
      "external runtime asset",
      (body) =>
        body.replace("</head>", '<script src="https://cdn.example/app.js"></script></head>'),
      /external origin/,
    ],
    [
      "deployment-alias canonical",
      (body) => body.replace("https://markiro.app/", "https://markiro.example/"),
      /invalid title, canonical, or H1/,
    ],
    [
      "duplicate canonical",
      (body) =>
        body.replace("</head>", '<link rel="canonical" href="https://markiro.app/"></head>'),
      /invalid title, canonical, or H1/,
    ],
  ]) {
    await t.test(name, async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) => {
        const parsed = new URL(url);
        if (parsed.hostname === "markiro.example" && parsed.pathname === "/")
          return landingResponse({
            body: mutate(landingShell()),
            headers: { "cache-control": "no-cache", "content-type": "text/html" },
          });
        return original(url, init);
      };

      await assert.rejects(
        runPublicSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.markiro.example",
            landingBaseUrl: "https://markiro.example",
          },
          client,
        ),
        expected,
      );
    });
  }
});

test("landing smoke permits public hreflang metadata outside the deployment origin", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "markiro.example" && parsed.pathname === "/")
      return landingResponse({
        body: landingShell().replace(
          "</head>",
          '<link rel="alternate" hreflang="ru" href="https://markiro.app/"><link rel="alternate" hreflang="en" href="https://markiro.app/en/"><link rel="alternate" hreflang="x-default" href="https://markiro.app/"></head>',
        ),
        headers: { "cache-control": "no-cache", "content-type": "text/html" },
      });
    return original(url, init);
  };

  await runPublicSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.markiro.example",
      landingBaseUrl: "https://markiro.example",
    },
    client,
  );
});

test("landing smoke rejects the application CSP without SmartCaptcha isolation", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) => {
    const parsed = new URL(url);
    if (parsed.hostname === "markiro.example" && parsed.pathname === "/") {
      return response({
        body: landingShell(),
        headers: { "cache-control": "no-cache", "content-type": "text/html" },
      });
    }
    return original(url, init);
  };

  await assert.rejects(
    runPublicSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.markiro.example",
        landingBaseUrl: "https://markiro.example",
      },
      client,
    ),
    /CSP is not the production policy on landing \/$/,
  );
});

test("kiosk smoke rejects shell, origin, manifest, worker, and route-boundary mutations", async (t) => {
  const releaseSha = "a".repeat(40);
  const cases = [
    [
      "admin shell substitution",
      "/",
      response({
        body: shell,
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/html",
          "x-markiro-release-sha": releaseSha,
        },
      }),
      /built kiosk shell/,
    ],
    [
      "external runtime origin",
      "/",
      response({
        body: kioskShell.replace("</body>", '<img src="https://cdn.example/icon.png"></body>'),
        headers: {
          "cache-control": "no-cache",
          "content-type": "text/html",
          "x-markiro-release-sha": releaseSha,
        },
      }),
      /external origin/,
    ],
    [
      "non-root manifest",
      "/manifest.webmanifest",
      response({
        body: JSON.stringify({ ...JSON.parse(kioskManifest), scope: "/kiosk/" }),
        headers: { "content-type": "application/manifest+json" },
      }),
      /root-scoped and installable/,
    ],
    [
      "API-caching service worker",
      "/sw.js",
      response({
        body: kioskServiceWorker.replace(
          "denylist:[/^\\/(?:api|station|kiosk)(?:\\/|$)/]",
          "denylist:[]",
        ),
        headers: { "content-type": "application/javascript" },
      }),
      /fallback includes reserved paths/,
    ],
    [
      "exact API navigation fallback",
      "/sw.js",
      response({
        body: kioskServiceWorker.replace(
          "denylist:[/^\\/(?:api|station|kiosk)(?:\\/|$)/]",
          "denylist:[/^\\/api\\//]",
        ),
        headers: { "content-type": "application/javascript" },
      }),
      /fallback includes reserved paths/,
    ],
    [
      "admin HTML on a rejected route",
      "/api/auth/get-session",
      response({ status: 404, body: shell, headers: { "content-type": "text/html" } }),
      /non-HTML 404/,
    ],
    [
      "kiosk shell on the bare API namespace",
      "/api",
      response({ status: 200, body: kioskShell, headers: { "content-type": "text/html" } }),
      /returned the kiosk shell/,
    ],
    [
      "admin shell on the bare station namespace",
      "/station",
      response({ status: 200, body: shell, headers: { "content-type": "text/html" } }),
      /non-HTML 404/,
    ],
    [
      "kiosk shell on the bare kiosk namespace",
      "/kiosk",
      response({ status: 200, body: kioskShell, headers: { "content-type": "text/html" } }),
      /returned the kiosk shell/,
    ],
  ];

  for (const [name, path, replacement, expected] of cases) {
    await t.test(name, async () => {
      const client = smokeClient(releaseSha);
      const original = client.request;
      client.request = (url, init) =>
        new URL(url).hostname === "kiosk.markiro.example" && new URL(url).pathname === path
          ? replacement
          : original(url, init);
      await assert.rejects(
        runPublicSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.markiro.example",
            landingBaseUrl: "https://markiro.example",
            expectedReleaseSha: releaseSha,
          },
          client,
        ),
        expected,
      );
    });
  }
});

const cleanStoppedState = Object.freeze({
  Status: "exited",
  Running: false,
  Paused: false,
  Restarting: false,
  OOMKilled: false,
  Dead: false,
  Pid: 0,
  ExitCode: 0,
  Error: "",
  StartedAt: "2026-08-04T10:00:00.000000000Z",
  FinishedAt: "2026-08-04T10:00:01.000000000Z",
});

function shutdownInspect(args, state = cleanStoppedState) {
  const value = args.includes("{{json .State}}") ? state : {};
  return { code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" };
}

test("defines the complete immutable public-route smoke contract", () => {
  assert.ok(Object.isFrozen(ROUTE_CHECKS));
  assert.deepEqual(
    ROUTE_CHECKS.map(({ method, path, kind, expected }) => [method, path, kind, expected]),
    [
      ["GET", "/", "admin-shell", "200 HTML admin shell"],
      ["GET", "/assets/${assetName}", "asset", "200, immutable cache"],
      ["GET", "/team/deep-link", "admin-shell", "200 admin shell, no-cache"],
      ["GET", "/api/auth/get-session", "proxy", "not SPA; upstream path retains /api/auth/"],
      ["GET", "/api/health/live", "json", "200 JSON from upstream /health/live"],
      ["GET", "/api/health/ready", "ready-json", "200 JSON from upstream /health/ready"],
      ["GET", "/station/bootstrap", "station-proxy", "not SPA"],
      ["GET", "/kiosk/bootstrap", "proxy", "not SPA"],
      ["POST", "/1c_exchange", "commerce-ml", "not SPA and request body reaches API unchanged"],
      ["GET", "/health/live", "json", "200 JSON"],
      ["GET", "/health/ready", "ready-json", "200 JSON ok or degraded"],
      ["GET", "/openapi.json", "json", "200 JSON"],
      ["GET", "/docs", "docs", "same-origin executable documentation shell"],
      ["GET", "/api/demo-requests", "not-found", "404, not HTML on admin authority"],
      ["POST", "/api/demo-requests", "not-found", "404, not HTML on admin authority"],
      ["POST", "/unknown", "not-found", "404, not HTML"],
    ],
  );
  for (const check of ROUTE_CHECKS) assert.ok(Object.isFrozen(check));

  assert.ok(Object.isFrozen(KIOSK_ROUTE_CHECKS));
  assert.deepEqual(KIOSK_ROUTE_CHECKS, [
    ["GET", "/", "kiosk-shell"],
    ["GET", "/assets/${assetName}", "asset"],
    ["GET", "/manifest.webmanifest", "manifest"],
    ["GET", "/sw.js", "service-worker"],
    ["GET", "/api/kiosk/bootstrap", "kiosk-proxy"],
    ["GET", "/api", "not-found"],
    ["HEAD", "/api", "not-found"],
    ["GET", "/api/auth/get-session", "not-found"],
    ["GET", "/station", "not-found"],
    ["HEAD", "/station", "not-found"],
    ["GET", "/station/bootstrap", "not-found"],
    ["GET", "/kiosk", "not-found"],
    ["HEAD", "/kiosk", "not-found"],
    ["GET", "/docs", "not-found"],
    ["POST", "/unknown", "not-found"],
  ]);
  for (const check of KIOSK_ROUTE_CHECKS) assert.ok(Object.isFrozen(check));

  assert.ok(Object.isFrozen(LANDING_ROUTE_CHECKS));
  assert.deepEqual(LANDING_ROUTE_CHECKS, [
    ["GET", "/", "landing-page"],
    ["GET", "/faq/", "landing-page"],
    ["GET", "/en/", "landing-page"],
    ["GET", "/en/chestny-znak-serialization/", "landing-page"],
    ["GET", "/en/sscc-and-aggregation/", "landing-page"],
    ["GET", "/en/packing-workstation/", "landing-page"],
    ["GET", "/en/self-service-pickup-kiosk/", "landing-page"],
    ["GET", "/en/1c-integration/", "landing-page"],
    ["GET", "/en/offline-production/", "landing-page"],
    ["GET", "/en/faq/", "landing-page"],
    ["GET", "/legal/", "landing-page"],
    ["GET", "/privacy/", "landing-page"],
    ["GET", "/personal-data-consent/", "landing-page"],
    ["GET", "/d/MKR-PD-01/2026.08/01/15.08.2026", "landing-page"],
    ["GET", "/robots.txt", "robots"],
    ["GET", "/sitemap.xml", "sitemap"],
    ["GET", "/llms.txt", "llms"],
    ["GET", "/api/demo-requests", "not-found"],
    ["HEAD", "/api/demo-requests", "not-found"],
    ["PUT", "/api/demo-requests", "not-found"],
    ["POST", "/api/demo-request", "not-found"],
    ["POST", "/api/demo-requests/", "not-found"],
    ["POST", "/api/demo-requests/extra", "not-found"],
    ["POST", "/api/other", "not-found"],
    ["GET", "/missing/", "branded-not-found"],
  ]);
  for (const check of LANDING_ROUTE_CHECKS) assert.ok(Object.isFrozen(check));

  assert.ok(Object.isFrozen(VBTECH_ROUTE_CHECKS));
  assert.deepEqual(VBTECH_ROUTE_CHECKS, [
    ["GET", "/", "vbtech-page"],
    ["GET", "/en/", "vbtech-page"],
    ["GET", "/legal/", "vbtech-page"],
    ["GET", "/privacy/", "vbtech-page"],
    ["GET", "/personal-data-consent/", "vbtech-page"],
    ["GET", "/api/contact", "not-found"],
    ["POST", "/api/contact/", "not-found"],
    ["POST", "/api/other", "not-found"],
    ["GET", "/api/auth/get-session", "not-found"],
    ["GET", "/station/bootstrap", "vbtech-not-found"],
    ["GET", "/kiosk/bootstrap", "vbtech-not-found"],
    ["POST", "/api/contact", "contact-state"],
  ]);
  for (const check of VBTECH_ROUTE_CHECKS) assert.ok(Object.isFrozen(check));
});

test("v-b smoke verifies independent release identity, canonical redirect and exact API surface", async () => {
  const releaseSha = "c".repeat(40);
  const requests = [];
  const html = `<!doctype html><html data-theme="light"><head><meta name="vbtech-release-sha" content="${releaseSha}"></head><body></body></html>`;
  const client = {
    async request(url, init) {
      const target = new URL(url);
      requests.push([init.method, target.hostname, target.pathname]);
      if (target.hostname === "www.v-b.tech")
        return vbtechResponse({
          status: 308,
          headers: { location: `https://v-b.tech${target.pathname}` },
        });
      if (target.pathname === "/api/contact" && init.method === "POST")
        return vbtechResponse({ status: 404, body: '{"code":"submission_disabled"}' });
      if (target.pathname.startsWith("/api/")) return vbtechResponse({ status: 404 });
      if (target.pathname === "/station/bootstrap" || target.pathname === "/kiosk/bootstrap")
        return vbtechResponse({
          status: 404,
          body: html,
          headers: { "content-type": "text/html" },
        });
      return vbtechResponse({ body: html, headers: { "content-type": "text/html" } });
    },
  };

  await runVbtechSmoke(
    {
      vbtechBaseUrl: "https://v-b.tech",
      vbtechWwwBaseUrl: "https://www.v-b.tech",
      expectedVbtechReleaseSha: releaseSha,
      vbtechSubmissionState: "disabled",
    },
    client,
  );

  assert.equal(requests.length, VBTECH_ROUTE_CHECKS.length + 1);
  assert.deepEqual(requests.at(-1), ["GET", "www.v-b.tech", "/canonical-check"]);
  assert.equal(
    requests.filter(([, host, path]) => host === "v-b.tech" && path === "/api/contact").length,
    2,
  );
});

test("smokes public routing, headers, and unprivileged runtime without accepting a proxied SPA", async () => {
  const client = smokeClient();
  const dockerCalls = [];
  const docker = {
    async run(command, args) {
      dockerCalls.push([command, args]);
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: '{"3000/tcp":null}\n', stderr: "" };
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  };

  await runSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.app.markiro.example",
      landingBaseUrl: "https://markiro.example",
      assetName: "main.js",
      environment: {},
    },
    client,
    docker,
  );

  assert.equal(
    client.requests.length,
    ROUTE_CHECKS.length + KIOSK_ROUTE_CHECKS.length + LANDING_ROUTE_CHECKS.length + 6,
  );
  assert.deepEqual(
    client.requests
      .map(({ url }) => new URL(url).pathname)
      .filter((path) => path.startsWith("/docs/")),
    ["/docs/scalar.js", "/docs/bootstrap.js"],
  );
  const commerceMl = client.requests.find(({ url }) => new URL(url).pathname === "/1c_exchange");
  assert.equal(commerceMl.init.body, "type=catalog&mode=checkauth");
  assert.equal(commerceMl.init.headers["content-type"], "application/x-www-form-urlencoded");
  const verification = client.requests.find(
    ({ url }) => new URL(url).pathname === "/d/MKR-PD-01/2026.08/01/15.08.2026",
  );
  assert.equal(verification.url.href, "https://markiro.example/d/MKR-PD-01/2026.08/01/15.08.2026");
  assert.equal(verification.init.redirect, "manual");
  const pdf = client.requests.find(
    ({ url }) => new URL(url).pathname === `/legal/files/${legalPdfFileName}`,
  );
  assert.ok(pdf);
  assert.deepEqual(
    dockerCalls.map(([command, args]) => [command, args.slice(-4)]),
    [
      ["docker", ["compose.production.yml", "ps", "-q", "api"]],
      ["docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", "container-id"]],
      ["docker", ["-T", "api", "id", "-u"]],
      ["docker", ["api", "test", "-w", "/"]],
    ],
  );
});

test("rejects an API container with an actual host port binding", async () => {
  for (const binding of [
    '{"3000/tcp":[{"HostIp":"0.0.0.0","HostPort":"3000"}]}\n',
    '{"3000/tcp":{"HostIp":"0.0.0.0","HostPort":"3000"}}\n',
  ]) {
    const docker = {
      async run(command, args) {
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "inspect") return { code: 0, stdout: binding, stderr: "" };
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    };

    await assert.rejects(
      runSmoke(
        {
          adminBaseUrl: "https://app.markiro.example",
          kioskBaseUrl: "https://kiosk.app.markiro.example",
          landingBaseUrl: "https://markiro.example",
          assetName: "main.js",
          environment: {},
        },
        smokeClient(),
        docker,
      ),
      /published/,
    );
  }
});

test("accepts only exact no-binding PortBindings shapes", async (t) => {
  for (const [name, binding] of [
    ["top-level null", "null\n"],
    ["empty object", "{}\n"],
    ["object containing only null values", '{"3000/tcp":null,"3001/tcp":null}\n'],
  ]) {
    await t.test(name, async () => {
      const docker = {
        async run(command, args) {
          if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
          if (args[0] === "inspect") return { code: 0, stdout: binding, stderr: "" };
          if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
          return { code: 1, stdout: "", stderr: "" };
        },
      };

      await runSmoke(
        {
          adminBaseUrl: "https://app.markiro.example",
          kioskBaseUrl: "https://kiosk.app.markiro.example",
          landingBaseUrl: "https://markiro.example",
          assetName: "main.js",
          environment: {},
        },
        smokeClient(),
        docker,
      );
    });
  }
});

test("rejects every non-null PortBindings value, including empty arrays", async (t) => {
  for (const [name, binding] of [
    ["empty array", '{"3000/tcp":[]}\n'],
    ["nonempty binding array", '{"3000/tcp":[{"HostIp":"","HostPort":"3000"}]}\n'],
    ["object", '{"3000/tcp":{}}\n'],
    ["string", '{"3000/tcp":""}\n'],
    ["number", '{"3000/tcp":0}\n'],
    ["boolean", '{"3000/tcp":false}\n'],
  ]) {
    await t.test(name, async () => {
      const docker = {
        async run(command, args) {
          if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
          if (args[0] === "inspect") return { code: 0, stdout: binding, stderr: "" };
          if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
          return { code: 1, stdout: "", stderr: "" };
        },
      };

      await assert.rejects(
        runSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.app.markiro.example",
            landingBaseUrl: "https://markiro.example",
            assetName: "main.js",
            environment: {},
          },
          smokeClient(),
          docker,
        ),
        /published/,
      );
    });
  }
});

test("rejects missing or invalid API host-port inspection output", async () => {
  for (const inspect of [
    { code: 1, stdout: "", stderr: "inspect failed" },
    { code: 0, stdout: "", stderr: "" },
    { code: 0, stdout: "not json", stderr: "" },
    { code: 0, stdout: "[]", stderr: "" },
    { code: 0, stdout: "[null]", stderr: "" },
    { code: 0, stdout: '"value"', stderr: "" },
    { code: 0, stdout: "0", stderr: "" },
    { code: 0, stdout: "false", stderr: "" },
  ]) {
    const docker = {
      async run(command, args) {
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "inspect") return inspect;
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "" };
      },
    };
    await assert.rejects(
      runSmoke(
        {
          adminBaseUrl: "https://app.markiro.example",
          kioskBaseUrl: "https://kiosk.app.markiro.example",
          landingBaseUrl: "https://markiro.example",
          assetName: "main.js",
          environment: {},
        },
        smokeClient(),
        docker,
      ),
      /port inspection/,
    );
  }
});

test("requires the pruned API runtime to exclude Playwright and OpenTelemetry", async (t) => {
  const dockerForProbe = (probeExitCode) => ({
    async run(_command, args) {
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: '{"3000/tcp":null}\n', stderr: "" };
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("node")) return { code: probeExitCode, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const options = {
    adminBaseUrl: "https://app.markiro.example",
    kioskBaseUrl: "https://kiosk.app.markiro.example",
    landingBaseUrl: "https://markiro.example",
    assetName: "main.js",
    environment: { SMOKE_ASSERT_DEPENDENCY_ISOLATION: "1" },
  };

  await t.test("accepts an isolated runtime", async () => {
    const calls = [];
    const docker = dockerForProbe(0);
    const run = docker.run.bind(docker);
    docker.run = async (command, args) => {
      calls.push([command, args]);
      return run(command, args);
    };

    await runSmoke(options, smokeClient(), docker);

    const probe = calls.find(([, args]) => args.includes("node"));
    assert.ok(probe);
    assert.deepEqual(probe[1].slice(-5, -2), ["node", "--input-type=module", "--eval"]);
    assert.equal(probe[1].at(-1), "/app/node_modules");
    assert.match(probe[1].at(-2), /@playwright\/test/);
    assert.match(probe[1].at(-2), /@opentelemetry\/api/);
    assert.doesNotMatch(probe[1].at(-2), /require\.resolve/);
  });

  await t.test("rejects a runtime containing either dependency", async () => {
    await assert.rejects(
      runSmoke(options, smokeClient(), dockerForProbe(1)),
      /forbidden tooling or telemetry dependency/,
    );
  });

  await t.test(
    "reports an indeterminate dependency scan separately from a forbidden match",
    async () => {
      await assert.rejects(
        runSmoke(options, smokeClient(), dockerForProbe(2)),
        /runtime dependency scan failed/,
      );
    },
  );
});

test("rejects every unavailable API container ID before inspect", async (t) => {
  for (const [name, ps] of [
    ["nonzero compose ps", { code: 1, stdout: "container-id\n", stderr: "ps failed" }],
    ["empty compose ps", { code: 0, stdout: "", stderr: "" }],
    ["whitespace compose ps", { code: 0, stdout: " \t\n", stderr: "" }],
  ]) {
    await t.test(name, async () => {
      let inspected = false;
      const docker = {
        async run(command, args) {
          if (args.includes("ps")) return ps;
          if (args[0] === "inspect") inspected = true;
          return { code: 1, stdout: "", stderr: "" };
        },
      };

      await assert.rejects(
        runSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.app.markiro.example",
            landingBaseUrl: "https://markiro.example",
            assetName: "main.js",
            environment: {},
          },
          smokeClient(),
          docker,
        ),
        /container ID is unavailable/,
      );
      assert.equal(inspected, false);
    });
  }
});

test("rejects an admin shell on an API response", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) => {
    if (new URL(url).pathname === "/api/auth/get-session")
      return response({ body: shell, headers: { "content-type": "text/html" } });
    return original(url, init);
  };
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };

  await assert.rejects(
    runSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.app.markiro.example",
        landingBaseUrl: "https://markiro.example",
        assetName: "main.js",
        environment: {},
      },
      client,
      docker,
    ),
    /admin shell/,
  );
});

test("rejects an external origin in the built root", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) => {
    if (new URL(url).pathname === "/") {
      return response({
        body: shell.replace(
          "</head>",
          '<link rel="stylesheet" href="https://cdn.example/style.css"></head>',
        ),
        headers: { "cache-control": "no-cache", "content-type": "text/html" },
      });
    }
    return original(url, init);
  };
  const docker = { run: async () => ({ code: 1, stdout: "", stderr: "" }) };

  await assert.rejects(
    runSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.app.markiro.example",
        landingBaseUrl: "https://markiro.example",
        assetName: "main.js",
        environment: {},
      },
      client,
      docker,
    ),
    /external origin/,
  );
});

test("accepts the exact Nest 11 JSON 404 for the absent station bootstrap endpoint", async () => {
  const client = smokeClient();
  const original = client.request;
  client.request = async (url, init) =>
    new URL(url).pathname === "/station/bootstrap"
      ? response({
          status: 404,
          body: '{"statusCode":404,"message":"Cannot GET /station/bootstrap","error":"Not Found"}',
          headers: { "content-type": "application/json" },
        })
      : original(url, init);
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };

  await runSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.app.markiro.example",
      landingBaseUrl: "https://markiro.example",
      assetName: "main.js",
      environment: {},
    },
    client,
    docker,
  );
});

test("preserves valid JSON 200, 401, and 403 station responses", async (t) => {
  for (const status of [200, 401, 403]) {
    await t.test(String(status), async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).hostname === "app.markiro.example" &&
        new URL(url).pathname === "/station/bootstrap"
          ? response({
              status,
              body: '{"upstream":true}',
              headers: { "content-type": "application/json; charset=utf-8" },
            })
          : original(url, init);
      const docker = {
        run: async (command, args) =>
          args.includes("ps")
            ? { code: 0, stdout: "container-id\n", stderr: "" }
            : args[0] === "inspect"
              ? { code: 0, stdout: "{}\n", stderr: "" }
              : args.includes("id")
                ? { code: 0, stdout: "10001\n", stderr: "" }
                : { code: 1, stdout: "", stderr: "" },
      };

      await runSmoke(
        {
          adminBaseUrl: "https://app.markiro.example",
          kioskBaseUrl: "https://kiosk.app.markiro.example",
          landingBaseUrl: "https://markiro.example",
          assetName: "main.js",
          environment: {},
        },
        client,
        docker,
      );
    });
  }
});

test("rejects arbitrary JSON 404 bodies for station bootstrap", async (t) => {
  for (const [name, body] of [
    ["generic Nest message", '{"statusCode":404,"message":"Not Found","error":"Not Found"}'],
    [
      "wrong request path",
      '{"statusCode":404,"message":"Cannot GET /station/other","error":"Not Found"}',
    ],
    ["missing error", '{"statusCode":404,"message":"Cannot GET /station/bootstrap"}'],
    [
      "extra property",
      '{"statusCode":404,"message":"Cannot GET /station/bootstrap","error":"Not Found","path":"/station/bootstrap"}',
    ],
    ["array", '[{"statusCode":404}]'],
    ["primitive", "404"],
  ]) {
    await t.test(name, async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).pathname === "/station/bootstrap"
          ? response({ status: 404, body, headers: { "content-type": "application/json" } })
          : original(url, init);
      const docker = {
        run: async (command, args) =>
          args.includes("ps")
            ? { code: 0, stdout: "container-id\n", stderr: "" }
            : args[0] === "inspect"
              ? { code: 0, stdout: "{}\n", stderr: "" }
              : args.includes("id")
                ? { code: 0, stdout: "10001\n", stderr: "" }
                : { code: 1, stdout: "", stderr: "" },
      };

      await assert.rejects(
        runSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.app.markiro.example",
            landingBaseUrl: "https://markiro.example",
            assetName: "main.js",
            environment: {},
          },
          client,
          docker,
        ),
        /station bootstrap/,
      );
    });
  }
});

test("rejects an edge 404 for station bootstrap and proxy 404s elsewhere", async () => {
  const docker = {
    run: async (command, args) =>
      args.includes("id")
        ? { code: 0, stdout: "10001\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "" },
  };
  for (const [path, altered, expected] of [
    [
      "/station/bootstrap",
      response({ status: 404, body: "not found", headers: { "content-type": "text/plain" } }),
      /station bootstrap/,
    ],
    [
      "/kiosk/bootstrap",
      response({ status: 404, headers: { "content-type": "application/json" } }),
      /proxy/,
    ],
    [
      "/api/health/live",
      response({ body: "not json", headers: { "content-type": "application/json" } }),
      /JSON/,
    ],
    [
      "/1c_exchange",
      response({ body: '{"status":"failure"}', headers: { "content-type": "application/json" } }),
      /1C exchange/,
    ],
  ]) {
    const client = smokeClient();
    const original = client.request;
    client.request = async (url, init) =>
      new URL(url).pathname === path ? altered : original(url, init);
    await assert.rejects(
      runSmoke(
        {
          adminBaseUrl: "https://app.markiro.example",
          kioskBaseUrl: "https://kiosk.app.markiro.example",
          landingBaseUrl: "https://markiro.example",
          assetName: "main.js",
          environment: {},
        },
        client,
        docker,
      ),
      expected,
    );
  }
});

test(
  "restores API after a failed or timed-out shutdown and rejects false-positive readiness",
  { timeout: 200 },
  async () => {
    for (const stop of [
      async () => ({ code: 1, stdout: "", stderr: "" }),
      async () => ({ code: 0, stdout: "", stderr: "", durationMs: 30_001 }),
      async () => new Promise(() => undefined),
    ]) {
      const calls = [];
      const docker = {
        async run(command, args) {
          calls.push(args);
          if (args[0] === "inspect") return shutdownInspect(args);
          if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
          if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
          if (args[0] === "stop") return stop();
          return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
        },
      };
      await assert.rejects(
        runSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.app.markiro.example",
            landingBaseUrl: "https://markiro.example",
            assetName: "main.js",
            environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
            commandTimeoutMs: 5,
          },
          smokeClient(),
          docker,
        ),
        /stop|timed out|gracefully/,
      );
      assert.ok(calls.some((args) => args.includes("up") && args.at(-1) === "api"));
    }

    const client = smokeClient();
    const docker = {
      restored: false,
      async run(command, args) {
        if (args[0] === "inspect") return shutdownInspect(args);
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
        if (args.includes("up")) this.restored = true;
        return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
      },
    };
    const original = client.request;
    client.request = async (url, init) =>
      docker.restored && new URL(url).pathname === "/health/ready"
        ? response({ body: shell, headers: { "content-type": "text/html" } })
        : original(url, init);
    await assert.rejects(
      runSmoke(
        {
          adminBaseUrl: "https://app.markiro.example",
          kioskBaseUrl: "https://kiosk.app.markiro.example",
          landingBaseUrl: "https://markiro.example",
          assetName: "main.js",
          environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
          commandTimeoutMs: 5,
          readinessAttempts: 1,
          readinessIntervalMs: 0,
          sleep: async () => undefined,
        },
        client,
        docker,
      ),
      /ready/,
    );
  },
);

test("restores the API through the fixed CI image override when requested", async () => {
  const calls = [];
  const docker = {
    async run(command, args) {
      calls.push(args);
      if (args[0] === "inspect") return shutdownInspect(args);
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
      return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
    },
  };

  await runSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.app.markiro.example",
      landingBaseUrl: "https://markiro.example",
      assetName: "main.js",
      environment: {
        MARKIRO_ENV_FILE: "/private/ci.env",
        MARKIRO_SMOKE_CI_OVERLAY: "1",
        SMOKE_ASSERT_SHUTDOWN: "1",
      },
    },
    smokeClient(),
    docker,
  );

  const restored = calls.find((args) => args.includes("up") && args.at(-1) === "api");
  assert.deepEqual(restored, [
    "compose",
    "--project-name",
    "markiro-production",
    "--env-file",
    "/private/ci.env",
    "-f",
    "compose.production.yml",
    "-f",
    "deploy/production/compose.ci.yml",
    "up",
    "-d",
    "--no-deps",
    "api",
  ]);
});

test("reports a restore failure after attempting shutdown", async () => {
  const calls = [];
  const docker = {
    async run(command, args) {
      calls.push(args);
      if (args[0] === "inspect") return shutdownInspect(args);
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
      if (args.includes("up")) return { code: 1, stdout: "", stderr: "" };
      return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
    },
  };

  await assert.rejects(
    runSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.app.markiro.example",
        landingBaseUrl: "https://markiro.example",
        assetName: "main.js",
        environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
        commandTimeoutMs: 5,
      },
      smokeClient(),
      docker,
    ),
    /not restored/,
  );
  assert.ok(calls.some((args) => args[0] === "stop"));
  assert.ok(calls.some((args) => args.includes("up") && args.at(-1) === "api"));
});

test("surfaces both sanitized shutdown and restoration failures", async () => {
  const docker = {
    async run(command, args) {
      if (args[0] === "inspect") return shutdownInspect(args);
      if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
      if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
      if (args[0] === "stop") return { code: 1, stdout: "", stderr: "secret stop stderr" };
      if (args.includes("up")) return { code: 1, stdout: "", stderr: "secret restore stderr" };
      return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
    },
  };

  await assert.rejects(
    runSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.app.markiro.example",
        landingBaseUrl: "https://markiro.example",
        assetName: "main.js",
        environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
      },
      smokeClient(),
      docker,
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /gracefully/);
      assert.match(error.message, /not restored/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});

test("rejects unclean stopped container states and always restores the API", async () => {
  for (const state of [
    { ...cleanStoppedState, ExitCode: 137 },
    { ...cleanStoppedState, OOMKilled: true },
    { ...cleanStoppedState, Error: "secret engine state detail" },
  ]) {
    const calls = [];
    const docker = {
      async run(command, args) {
        calls.push(args);
        if (args[0] === "inspect") return shutdownInspect(args, state);
        if (args.includes("id")) return { code: 0, stdout: "10001\n", stderr: "" };
        if (args.includes("ps")) return { code: 0, stdout: "container-id\n", stderr: "" };
        if (args[0] === "stop") return { code: 0, stdout: "", stderr: "", durationMs: 1 };
        return { code: args.includes("test") ? 1 : 0, stdout: "", stderr: "" };
      },
    };

    await assert.rejects(
      runSmoke(
        {
          adminBaseUrl: "https://app.markiro.example",
          kioskBaseUrl: "https://kiosk.app.markiro.example",
          landingBaseUrl: "https://markiro.example",
          assetName: "main.js",
          environment: { SMOKE_ASSERT_SHUTDOWN: "1" },
        },
        smokeClient(),
        docker,
      ),
      (error) => {
        assert.match(error.message, /cleanly/);
        assert.doesNotMatch(error.message, /secret engine/);
        return true;
      },
    );
    assert.ok(calls.some((args) => args.includes("{{json .State}}")));
    assert.ok(calls.some((args) => args.includes("up") && args.at(-1) === "api"));
  }
});

test("rejects an unbranded HTML body for the landing missing route", async () => {
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };
  const html404 = smokeClient();
  const original404 = html404.request;
  html404.request = async (url, init) =>
    new URL(url).hostname === "markiro.example" && new URL(url).pathname === "/missing/"
      ? landingResponse({
          status: 404,
          body: "not found",
          headers: { "cache-control": "no-cache", "content-type": "text/html" },
        })
      : original404(url, init);
  await assert.rejects(
    runSmoke(
      {
        adminBaseUrl: "https://app.markiro.example",
        kioskBaseUrl: "https://kiosk.app.markiro.example",
        landingBaseUrl: "https://markiro.example",
        assetName: "main.js",
        environment: {},
      },
      html404,
      docker,
    ),
    /bounded branded 404/,
  );

  const structured = smokeClient();
  const originalStructured = structured.request;
  structured.request = async (url, init) =>
    new URL(url).hostname === "app.markiro.example" && new URL(url).pathname === "/docs"
      ? response({
          body: `<html><title>Markiro</title><p>/assets/main.js</p><script src="/docs/scalar.js"></script><script src="/docs/bootstrap.js"></script></html>`,
          headers: { "content-type": "text/html" },
        })
      : originalStructured(url, init);
  await runSmoke(
    {
      adminBaseUrl: "https://app.markiro.example",
      kioskBaseUrl: "https://kiosk.app.markiro.example",
      landingBaseUrl: "https://markiro.example",
      assetName: "main.js",
      environment: {},
    },
    structured,
    docker,
  );
});

test("rejects documentation that cannot execute under the production CSP", async (t) => {
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };

  for (const [name, docs, expected] of [
    [
      "inline initializer",
      '<html><script src="/docs/scalar.js"></script><script>Scalar.createApiReference()</script></html>',
      /inline script/,
    ],
    [
      "external bundle",
      '<html><script src="https://cdn.example/scalar.js"></script><script src="/docs/bootstrap.js"></script></html>',
      /external origin/,
    ],
  ]) {
    await t.test(name, async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).pathname === "/docs"
          ? response({ body: docs, headers: { "content-type": "text/html" } })
          : original(url, init);
      await assert.rejects(
        runSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.app.markiro.example",
            landingBaseUrl: "https://markiro.example",
            assetName: "main.js",
            environment: {},
          },
          client,
          docker,
        ),
        expected,
      );
    });
  }
});

test("rejects unavailable documentation scripts and a bootstrap with the wrong document target", async (t) => {
  const docker = {
    run: async (command, args) =>
      args.includes("ps")
        ? { code: 0, stdout: "container-id\n", stderr: "" }
        : args[0] === "inspect"
          ? { code: 0, stdout: "{}\n", stderr: "" }
          : args.includes("id")
            ? { code: 0, stdout: "10001\n", stderr: "" }
            : { code: 1, stdout: "", stderr: "" },
  };

  for (const [name, path, overridden, expected] of [
    [
      "wrong script content type",
      "/docs/scalar.js",
      response({ body: "window.Scalar={}", headers: { "content-type": "text/html" } }),
      /JavaScript/,
    ],
    [
      "empty script",
      "/docs/scalar.js",
      response({ body: "", headers: { "content-type": "application/javascript" } }),
      /empty/,
    ],
    [
      "missing Scalar browser global",
      "/docs/scalar.js",
      response({
        body: "function createApiReference() {}",
        headers: { "content-type": "application/javascript" },
      }),
      /browser global/,
    ],
    [
      "Scalar dynamic code probe",
      "/docs/scalar.js",
      response({
        body: "window.Scalar = { createApiReference: () => Function(``) };",
        headers: { "content-type": "application/javascript" },
      }),
      /dynamic code/,
    ],
    [
      "wrong OpenAPI target",
      "/docs/bootstrap.js",
      response({
        body: 'Scalar.createApiReference("#app", { url: "/private.json" });',
        headers: { "content-type": "application/javascript" },
      }),
      /openapi\.json/,
    ],
    [
      "missing disabled interactive integrations",
      "/docs/bootstrap.js",
      response({
        body: 'Scalar.createApiReference("#app", { url: "/openapi.json" });',
        headers: { "content-type": "application/javascript" },
      }),
      /safe Scalar configuration/,
    ],
  ]) {
    await t.test(name, async () => {
      const client = smokeClient();
      const original = client.request;
      client.request = async (url, init) =>
        new URL(url).pathname === path ? overridden : original(url, init);
      await assert.rejects(
        runSmoke(
          {
            adminBaseUrl: "https://app.markiro.example",
            kioskBaseUrl: "https://kiosk.app.markiro.example",
            landingBaseUrl: "https://markiro.example",
            assetName: "main.js",
            environment: {},
          },
          client,
          docker,
        ),
        expected,
      );
    });
  }
});
