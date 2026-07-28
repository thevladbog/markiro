import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  ADMIN_ORIGIN: z.string().url().default("http://localhost:5173"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Express `trust proxy` hop count (see main.ts). Defaults to 0 (direct
  // exposure / dev / tests) rather than `true`, which would trust a
  // left-most, attacker-supplied X-Forwarded-For entry.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
});
export type Env = z.infer<typeof EnvSchema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
