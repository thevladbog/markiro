import type {
  CorsOptions,
  CorsOptionsDelegate,
} from "@nestjs/common/interfaces/external/cors-options.interface";
import type { Request } from "express";
import { kioskAllowedOrigins, sessionAllowedOrigins, stationAllowedOrigins, type Env } from "./env";

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

/**
 * True only for device-facing station routes. Keep the trailing slash so the
 * session-guarded `/stations` cabinet controller never inherits the station
 * webview's CORS authority.
 */
function isStationPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === "/station" || p.startsWith("/station/");
}

/**
 * Per-route CORS policy: device origins are trusted only on their own
 * `/kiosk/*` or `/station/*` routes.
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
  const session: CorsOptions = { origin: sessionAllowedOrigins(env), credentials: true };
  // `req.path` rather than `req.url`: the latter carries the query string,
  // which would break the prefix test on any `/kiosk/...?x=1` request.
  return (req, cb) => {
    if (isKioskPath(req.path)) return cb(null, kiosk);
    if (isStationPath(req.path)) return cb(null, station);
    return cb(null, session);
  };
}
