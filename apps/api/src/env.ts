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
const canonicalOriginSchema = z.url().transform((value, ctx) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "must be an http(s) origin" });
    return z.NEVER;
  }
  return url.origin;
});

const exactCanonicalOriginSchema = z
  .url()
  .refine((value) => new URL(value).origin === value, "must be a canonical browser origin")
  .pipe(canonicalOriginSchema);

const canonicalHttpUrlSchema = z.url().transform((value, ctx) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "must be an http(s) URL" });
    return z.NEVER;
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: "custom", message: "must not include userinfo" });
    return z.NEVER;
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
});

/**
 * A station webview origin. In addition to a canonical HTTP(S) origin, Tauri
 * desktop builds may identify their non-opaque production webview as exactly
 * `tauri://localhost`. Do not accept `null`, `file:`, or arbitrary custom
 * schemes: they represent opaque origins or widen CORS beyond an identifiable
 * station webview.
 */
const stationOriginSchema = z.url().transform((value, ctx) => {
  if (value === "tauri://localhost") return value;

  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "must be an http(s) or tauri://localhost origin" });
    return z.NEVER;
  }
  if (url.username || url.password) {
    ctx.addIssue({ code: "custom", message: "must not include userinfo" });
    return z.NEVER;
  }
  return url.origin;
});

const explicitBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");

const mailEncryptionKeySchema = z
  .string()
  .refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === 32 && decoded.toString("base64") === value;
  }, "must be a canonical base64-encoded 32-byte key")
  .transform((value) => Buffer.from(value, "base64"));

const DEVELOPMENT_MAIL_DEFAULTS = {
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  SMTP_FROM_EMAIL: "no-reply@markiro.local",
  SMTP_FROM_NAME: "Маркиро",
  // Deterministic and explicitly non-secret. Production has no defaults and
  // must provide an independent random key.
  MAIL_PAYLOAD_ENCRYPTION_KEY: Buffer.alloc(32, 0x6d).toString("base64"),
} satisfies NodeJS.ProcessEnv;

const DEVELOPMENT_STORAGE_DEFAULTS = {
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "markiro-private",
  S3_ACCESS_KEY_ID: "markiro",
  S3_SECRET_ACCESS_KEY: "markiro-development-only",
  S3_FORCE_PATH_STYLE: "true",
} satisfies NodeJS.ProcessEnv;

const storageEndpointSchema = z.url().transform((value, ctx) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    ctx.addIssue({ code: "custom", message: "must be an http(s) endpoint" });
    return z.NEVER;
  }
  return url.toString();
});

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(16),
    BETTER_AUTH_URL: z.url(),
    PLATFORM_AUTH_SECRET: z.string().min(32),
    PLATFORM_AUTH_URL: canonicalHttpUrlSchema,
    // The default is returned as written, not canonicalized: zod's `.default()`
    // short-circuits parsing entirely when the input is undefined, so the
    // transform above never sees it. Harmless only because the literal is
    // already a bare origin -- keep it that way.
    ADMIN_ORIGIN: canonicalOriginSchema.default("http://localhost:5173"),
    SAAS_ADMIN_ORIGIN: canonicalOriginSchema,
    SUBSCRIPTION_ENFORCEMENT_MODE: z.enum(["managed_only", "all"]).default("managed_only"),
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
    KIOSK_ORIGIN: canonicalOriginSchema.optional(),
    // Exact origin used by the Tauri station shell. This is intentionally
    // optional for existing admin-only deployments; unset means that only the
    // admin origin may reach `/station/*`. Configure an exact HTTP(S) origin
    // for a deployed webview, or `tauri://localhost` for Tauri's supported
    // non-opaque custom-protocol origin. Never use `null`.
    STATION_ORIGIN: stationOriginSchema.optional(),
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
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535),
    SMTP_SECURE: explicitBooleanSchema.optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_FROM_EMAIL: z.email(),
    SMTP_FROM_NAME: z.string().min(1),
    SMTP_REPLY_TO: z.email().optional(),
    MAIL_PAYLOAD_ENCRYPTION_KEY: mailEncryptionKeySchema,
    LANDING_DEMO_SUBMISSION_ENABLED: explicitBooleanSchema
      .optional()
      .transform((value) => value ?? false),
    LANDING_ORIGIN: exactCanonicalOriginSchema.optional(),
    LANDING_DEMO_RECIPIENT: z.email().optional(),
    LANDING_DEMO_REPLY_TO: z.email().optional(),
    SMARTCAPTCHA_SERVER_KEY: z.string().startsWith("ysc2_").optional(),
    LANDING_DEMO_RATE_WINDOW_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
    LANDING_DEMO_SOURCE_LIMIT: z.coerce.number().int().min(1).max(100).default(5),
    LANDING_DEMO_GLOBAL_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
    S3_ENDPOINT: storageEndpointSchema,
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: explicitBooleanSchema,
    DADATA_TOKEN: z.string().trim().min(1).optional(),
    DADATA_SECRET: z.string().trim().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.PLATFORM_AUTH_SECRET === env.BETTER_AUTH_SECRET) {
      ctx.addIssue({
        code: "custom",
        path: ["PLATFORM_AUTH_SECRET"],
        message: "must differ from BETTER_AUTH_SECRET",
      });
    }
    if (env.SAAS_ADMIN_ORIGIN === env.ADMIN_ORIGIN) {
      ctx.addIssue({
        code: "custom",
        path: ["SAAS_ADMIN_ORIGIN"],
        message: "must differ from ADMIN_ORIGIN",
      });
    }
    if (env.SMTP_PORT === 465 && env.SMTP_SECURE === false) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_SECURE"],
        message: "port 465 requires implicit TLS",
      });
    }
    if (env.SMTP_PORT === 587 && env.SMTP_SECURE === true) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_SECURE"],
        message: "port 587 requires STARTTLS",
      });
    }
    if (env.LANDING_DEMO_GLOBAL_LIMIT < env.LANDING_DEMO_SOURCE_LIMIT) {
      ctx.addIssue({
        code: "custom",
        path: ["LANDING_DEMO_GLOBAL_LIMIT"],
        message: "must be at least LANDING_DEMO_SOURCE_LIMIT",
      });
    }
    if (env.LANDING_DEMO_SUBMISSION_ENABLED) {
      for (const name of [
        "LANDING_ORIGIN",
        "LANDING_DEMO_RECIPIENT",
        "LANDING_DEMO_REPLY_TO",
        "SMARTCAPTCHA_SERVER_KEY",
      ] as const) {
        if (!env[name]) {
          ctx.addIssue({ code: "custom", path: [name], message: "required when enabled" });
        }
      }
    }
    if (env.DADATA_SECRET && !env.DADATA_TOKEN) {
      ctx.addIssue({
        code: "custom",
        path: ["DADATA_SECRET"],
        message: "requires DADATA_TOKEN",
      });
    }
    if (env.NODE_ENV !== "production") return;
    if (!env.SMTP_USER) {
      ctx.addIssue({ code: "custom", path: ["SMTP_USER"], message: "required in production" });
    }
    if (!env.SMTP_PASSWORD) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_PASSWORD"],
        message: "required in production",
      });
    }
  })
  .transform((env) => ({
    ...env,
    SMTP_SECURE: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
  }));
export type Env = z.infer<typeof EnvSchema>;
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // An unset optional variable reaches us as an empty string more often than
  // as `undefined`: `KIOSK_ORIGIN: ${KIOSK_ORIGIN}` in a compose file and a
  // blank line in a .env both produce "". Zod's `.optional()` only skips
  // `undefined`, so without this an operator who left the placeholder empty
  // would get a boot failure ("Invalid url") instead of "no kiosk configured".
  const mailDefaults = source.NODE_ENV === "production" ? {} : DEVELOPMENT_MAIL_DEFAULTS;
  const storageDefaults = source.NODE_ENV === "production" ? {} : DEVELOPMENT_STORAGE_DEFAULTS;
  const normalizedSource = { ...source };
  for (const name of [
    ...Object.keys(DEVELOPMENT_MAIL_DEFAULTS),
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_REPLY_TO",
    "LANDING_DEMO_SUBMISSION_ENABLED",
    "LANDING_ORIGIN",
    "LANDING_DEMO_RECIPIENT",
    "LANDING_DEMO_REPLY_TO",
    "SMARTCAPTCHA_SERVER_KEY",
    "LANDING_DEMO_RATE_WINDOW_SECONDS",
    "LANDING_DEMO_SOURCE_LIMIT",
    "LANDING_DEMO_GLOBAL_LIMIT",
    ...Object.keys(DEVELOPMENT_STORAGE_DEFAULTS),
    "DADATA_TOKEN",
    "DADATA_SECRET",
  ]) {
    if (normalizedSource[name]?.trim() === "") delete normalizedSource[name];
  }
  return EnvSchema.parse({
    ...mailDefaults,
    ...storageDefaults,
    ...normalizedSource,
    KIOSK_ORIGIN: normalizedSource.KIOSK_ORIGIN || undefined,
    STATION_ORIGIN: normalizedSource.STATION_ORIGIN || undefined,
  });
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

/** Exact origin trusted by the separate platform-session surface only. */
export function platformAllowedOrigins(env: Env): string[] {
  return [env.SAAS_ADMIN_ORIGIN];
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

/**
 * Origins allowed on the device-facing `/station/*` routes. Like the kiosk,
 * a station has a device credential rather than a browser session, so its
 * origin must not gain access to the session-guarded or kiosk surfaces.
 */
export function stationAllowedOrigins(env: Env): string[] {
  return [...new Set([env.ADMIN_ORIGIN, ...(env.STATION_ORIGIN ? [env.STATION_ORIGIN] : [])])];
}
