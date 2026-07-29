import { z } from "zod";

/**
 * A browser origin -- `scheme://host[:port]` and nothing else.
 *
 * `z.string().url()` on its own is not enough. It accepts
 * `https://kiosk.example.ru/` and `https://kiosk.example.ru/pickup`, both
 * perfectly good URLs, but a browser sends `Origin` as a bare
 * `scheme://host[:port]`, and both the `cors` package and Better Auth compare
 * configured entries against that header as plain strings. A trailing slash
 * or a path therefore matches nothing, ever -- and it fails silently: a
 * non-matching origin is not an error server-side (the response simply omits
 * `Access-Control-Allow-Origin`), so the only symptom is a bare network error
 * in the device's console with nothing in the API log. Canonicalize rather
 * than merely validate: `new URL(v).origin` drops the trailing slash, path,
 * query and fragment, and lowercases the host.
 *
 * Non-HTTP(S) schemes are refused outright rather than canonicalized:
 * `new URL("mailto:a@b").origin` is the literal string `"null"`, which is
 * also what a browser sends as the Origin of a sandboxed iframe or a
 * `file://` document -- allowlisting it would hand access to every opaque
 * origin at once.
 */
const browserOriginSchema = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: "custom", message: "must be an http(s) origin" });
      return z.NEVER;
    }
    return url.origin;
  });

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  // The default is returned as written, not canonicalized: zod's `.default()`
  // short-circuits parsing entirely when the input is undefined, so the
  // transform above never sees it. Harmless only because the literal is
  // already a bare origin -- keep it that way.
  ADMIN_ORIGIN: browserOriginSchema.default("http://localhost:5173"),
  // Origin the pickup kiosk PWA (apps/kiosk) is served from, when it is
  // served from one at all. OPTIONAL, and deliberately WITHOUT a localhost
  // default, unlike ADMIN_ORIGIN:
  //   - Required would break every existing admin-only deployment on
  //     upgrade -- `loadEnv()` throws before `NestFactory.create`, so the
  //     container would crash-loop on a variable its operator has no kiosk
  //     for.
  //   - A `http://localhost:5373` default would instead silently add a
  //     permanently-trusted origin to the `/kiosk/*` CORS allowlist in every
  //     deployment that has no kiosk.
  //     ADMIN_ORIGIN can carry a default because there is always an admin
  //     app; a kiosk is genuinely optional, so its absence must mean "not
  //     allowed", not "allowed at a guessed address".
  // Dev needs no value either way: apps/kiosk/vite.config.ts proxies /api
  // same-origin, so CORS never engages there. It is the on-prem split-host
  // deployment the kiosk's own pairing screen advertises (a server-address
  // field) that needs this set.
  KIOSK_ORIGIN: browserOriginSchema.optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Keys `hashPairingCode` (apps/api/src/pickup/device-token.ts), the HMAC
  // that hashes the 8-digit kiosk pairing code before it is stored/looked up.
  // Required, no default: an unkeyed digest over a 10^8 code space is
  // trivially brute-forceable offline from a DB dump, which would let anyone
  // holding one redeem every still-live pairing code directly, bypassing the
  // HTTP rate limiter entirely. Rotating this value invalidates every
  // outstanding pairing code -- acceptable, since they live only 15 minutes.
  PAIRING_CODE_PEPPER: z.string().min(16),
  // Express `trust proxy` hop count (see main.ts). Defaults to 0 (direct
  // exposure / dev / tests) rather than `true`, which would trust a
  // left-most, attacker-supplied X-Forwarded-For entry.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
});
export type Env = z.infer<typeof EnvSchema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // An unset optional variable reaches us as an empty string more often than
  // as `undefined`: `KIOSK_ORIGIN: ${KIOSK_ORIGIN}` in a compose file and a
  // blank line in a .env both produce "". Zod's `.optional()` only skips
  // `undefined`, so without this an operator who left the placeholder empty
  // would get a boot failure ("Invalid url") instead of "no kiosk configured".
  return EnvSchema.parse({ ...source, KIOSK_ORIGIN: source.KIOSK_ORIGIN || undefined });
}

/**
 * Origins allowed to make credentialed cross-origin requests to the
 * session-guarded surface -- everything that is not `/kiosk/*`.
 *
 * Still a single source for two allowlists: this same list is both the CORS
 * policy for those routes (main.ts) and Better Auth's `trustedOrigins`
 * (auth/auth.setup.ts). Keeping THOSE two together is still worth it, because
 * an origin that clears CORS but not the origin check gets an opaque 403
 * mid-flow, and one that clears the origin check but not CORS gets a bare
 * network error the browser refuses to explain. `/api/auth/*` is part of this
 * surface, so the two genuinely describe the same set.
 *
 * KIOSK_ORIGIN is deliberately absent. The kiosk calls no `/api/auth/*` route
 * (it authenticates with a device token) and no non-kiosk route at all, so
 * listing it here would grant an origin read access to every session-guarded
 * response for no functional gain: in the same-site subdomain deployment this
 * product actually ships, anything running on the kiosk origin could then
 * send an administrator's cookies with `credentials: "include"` and read the
 * result.
 */
export function sessionAllowedOrigins(env: Env): string[] {
  return [env.ADMIN_ORIGIN];
}

/**
 * Origins allowed on the device-facing `/kiosk/*` routes.
 *
 * The admin origin stays allowed here too -- unchanged from when one list
 * served both surfaces, and it costs nothing: these routes are guarded by a
 * device token, never by a session cookie, so an admin-origin caller reaching
 * them has no ambient credential to spend.
 */
export function kioskAllowedOrigins(env: Env): string[] {
  // Deduplicated: a single-host deployment that serves admin and kiosk from
  // the same origin sets both variables to the same value.
  return [...new Set([env.ADMIN_ORIGIN, ...(env.KIOSK_ORIGIN ? [env.KIOSK_ORIGIN] : [])])];
}
