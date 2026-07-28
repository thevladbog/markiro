import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  ADMIN_ORIGIN: z.string().url().default("http://localhost:5173"),
  // Origin the pickup kiosk PWA (apps/kiosk) is served from, when it is
  // served from one at all. OPTIONAL, and deliberately WITHOUT a localhost
  // default, unlike ADMIN_ORIGIN:
  //   - Required would break every existing admin-only deployment on
  //     upgrade -- `loadEnv()` throws before `NestFactory.create`, so the
  //     container would crash-loop on a variable its operator has no kiosk
  //     for.
  //   - A `http://localhost:5373` default would instead silently add a
  //     permanently-trusted origin to BOTH the CORS allowlist and Better
  //     Auth's `trustedOrigins` in every deployment that has no kiosk.
  //     ADMIN_ORIGIN can carry a default because there is always an admin
  //     app; a kiosk is genuinely optional, so its absence must mean "not
  //     allowed", not "allowed at a guessed address".
  // Dev needs no value either way: apps/kiosk/vite.config.ts proxies /api
  // same-origin, so CORS never engages there. It is the on-prem split-host
  // deployment the kiosk's own pairing screen advertises (a server-address
  // field) that needs this set.
  KIOSK_ORIGIN: z.string().url().optional(),
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
 * Browser origins allowed to make credentialed cross-origin requests.
 *
 * Single source for BOTH allowlists -- the CORS middleware (main.ts) and
 * Better Auth's `trustedOrigins` (auth/auth.setup.ts) -- because the two
 * failing apart is worse than either failing: an origin that clears CORS but
 * not the origin check gets an opaque 403 mid-flow, and one that clears the
 * origin check but not CORS gets a bare network error the browser refuses to
 * explain. Callers keep passing this to both.
 */
export function allowedOrigins(env: Env): string[] {
  // Deduplicated: a single-host deployment that serves admin and kiosk from
  // the same origin sets both variables to the same value.
  return [...new Set([env.ADMIN_ORIGIN, ...(env.KIOSK_ORIGIN ? [env.KIOSK_ORIGIN] : [])])];
}
