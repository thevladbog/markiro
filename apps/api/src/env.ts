import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  ADMIN_ORIGIN: z.string().url().default("http://localhost:5173"),
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
  return EnvSchema.parse(source);
}
