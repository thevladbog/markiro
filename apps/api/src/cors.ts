import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface";
import type { Request } from "express";
import {
  kioskAllowedOrigins,
  platformAllowedOrigins,
  sessionAllowedOrigins,
  stationAllowedOrigins,
  type Env,
} from "./env";

/**
 * True for the device-facing routes, and only those: `/kiosk/pair`,
 * `/kiosk/bootstrap`, `/kiosk/orders`.
 *
 * Note the trailing slash in the prefix -- `/kiosks` (the cabinet-facing,
 * session-guarded controller) must NOT match, and `startsWith("/kiosk")`
 * would have matched it. Lowercased first because Express routes
 * case-insensitively by default, so `/KIOSK/orders` reaches the kiosk
 * controllers and must get the same policy they do. Erring this way cannot
 * over-grant: every path under `/kiosk/` routes to a kiosk controller or to
 * a 404, never to a session-guarded handler.
 */
function isKioskPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === "/kiosk" || p.startsWith("/kiosk/");
}

function isPlatformPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    normalized === "/platform" ||
    normalized.startsWith("/platform/") ||
    normalized === "/api/platform-auth" ||
    normalized.startsWith("/api/platform-auth/")
  );
}

/** Exact method/path CORS surface used by the station webview. */
function isStationRequest(req: Request): boolean {
  const preflightMethod = req.headers["access-control-request-method"];
  const method =
    req.method.toUpperCase() === "OPTIONS"
      ? typeof preflightMethod === "string"
        ? preflightMethod.toUpperCase()
        : "OPTIONS"
      : req.method.toUpperCase();
  const path = (req.path.replace(/\/+$/, "") || "/").toLowerCase();

  if (
    (method === "POST" &&
      (path === "/station/pair" ||
        path === "/station/conflicts/status" ||
        path === "/station/scans" ||
        path === "/station/shift-closures")) ||
    (method === "GET" && (path === "/station/identity" || path === "/station/operators")) ||
    ((method === "GET" || method === "POST") && path === "/shifts") ||
    (method === "GET" && path === "/shifts/box-label-templates") ||
    (method === "GET" && path === "/products") ||
    (method === "POST" && path === "/products/gtin-check")
  ) {
    return true;
  }

  return (
    (method === "GET" && /^\/station\/products\/[^/]+\/image\/[^/]+$/.test(path)) ||
    (method === "GET" && /^\/shifts\/[^/]+\/(?:bundle|reference-bundle)$/.test(path)) ||
    (method === "POST" && /^\/shifts\/[^/]+\/open$/.test(path))
  );
}

/**
 * Per-route CORS policy: device origins are trusted only on their documented
 * method/path surfaces.
 *
 * A single global policy would make KIOSK_ORIGIN a credentialed reader of
 * every route in the API. That is a real exposure in the deployment this
 * product ships (kiosk and admin as sibling subdomains of one site): script
 * running on the kiosk origin -- a compromised PWA build, a stored XSS, an
 * operator browsing on the tablet -- could then call any session-guarded
 * route with `credentials: "include"`, and the browser would hand it the
 * response. Scoping costs nothing, because the kiosk calls `/kiosk/*` and
 * nothing else (see apps/kiosk/src/api/client.ts).
 *
 * `cors` calls this delegate per request. Both option objects are built once
 * here, not per call.
 *
 * `allowedHeaders` is left unset on all policies, on purpose: `cors` then
 * echoes whatever `Access-Control-Request-Headers` asked for, which is how
 * device headers clear preflight without being named here.
 */
export function corsDelegate(env: Env): CorsOptionsDelegate<Request> {
  const kiosk: CorsOptions = { origin: kioskAllowedOrigins(env), credentials: true };
  const station: CorsOptions = { origin: stationAllowedOrigins(env), credentials: true };
  const platform: CorsOptions = { origin: platformAllowedOrigins(env), credentials: true };
  const session: CorsOptions = { origin: sessionAllowedOrigins(env), credentials: true };
  // `req.path` rather than `req.url`: the latter carries the query string,
  // which would break the prefix test on any `/kiosk/...?x=1` request.
  return (req, cb) => {
    if (isKioskPath(req.path)) return cb(null, kiosk);
    if (isPlatformPath(req.path)) return cb(null, platform);
    if (isStationRequest(req)) return cb(null, station);
    return cb(null, session);
  };
}
