import { z } from "zod";
import {
  provisionUsTraceabilityProfileSchema,
  usTraceabilityProfileSummarySchema,
} from "@markiro/platform-contracts";

export type UsClientErrorCode =
  | "invalid_input"
  | "invalid_response"
  | "session_required"
  | "forbidden"
  | "conflict"
  | "rate_limited"
  | "profile_not_provisioned"
  | "unavailable"
  | "request_rejected";

/** Safe translation key only. Never retain a raw response, payload or error cause. */
export class UsClientError extends Error {
  constructor(readonly code: UsClientErrorCode) {
    super(code);
    this.name = "UsClientError";
  }
}

const userSchema = z.object({
  id: z.string().min(1),
  email: z.email(),
  name: z.string(),
  twoFactorEnabled: z.boolean(),
});
const sessionSchema = z
  .object({
    user: userSchema,
    session: z.object({ activeOrganizationId: z.string().min(1).nullish() }),
  })
  .nullable();
const signedInSchema = z.union([
  z
    .object({ twoFactorRedirect: z.literal(true) })
    .transform(() => ({ step: "mfa_required" as const })),
  z
    .object({ token: z.string().min(1), user: userSchema })
    .transform(() => ({ step: "password_session" as const })),
]);
const organizationSchema = z.object({ id: z.string().min(1), name: z.string(), slug: z.string() });
const verificationSchema = z
  .object({ token: z.string().min(1), user: userSchema })
  .transform(() => undefined);
const enrollmentSchema = z.object({
  totpURI: z.string().refine((value) => {
    try {
      const uri = new URL(value);
      return (
        uri.protocol === "otpauth:" &&
        uri.hostname === "totp" &&
        /^[A-Z2-7]+=*$/i.test(uri.searchParams.get("secret") ?? "")
      );
    } catch {
      return false;
    }
  }),
  backupCodes: z.array(z.string().min(1)).min(1),
});
const passwordSchema = z.string().min(1).max(128);
const profilePath = "/api/us/traceability/profile";
const deploymentSchema = z
  .object({
    edition: z.literal("US"),
    releaseEnabled: z.literal(false),
    interfaceLocales: z.tuple([z.literal("en-US"), z.literal("es-US")]),
    defaultInterfaceLocale: z.literal("en-US"),
  })
  .strict();

function checked<S extends z.ZodType>(
  schema: S,
  value: unknown,
  code: UsClientErrorCode,
): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new UsClientError(code);
  return result.data;
}

/** Only fixed same-origin US routes; no RU client imports, retries or persistence.
 * The US browser entry must separately attest edition and configure its proxy.
 * Callers must keep enrollment material out of query caches and persistent stores.
 */
export function createUsBrowserClient(send: typeof fetch = globalThis.fetch.bind(globalThis)) {
  async function request<S extends z.ZodType>(
    path: string,
    schema: S,
    method = "GET",
    body?: unknown,
  ): Promise<z.output<S>> {
    let response: Response;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 15_000);
    try {
      response = await send(path, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      });
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        if (controller.signal.aborted) throw new UsClientError("unavailable");
        if (response.ok) throw new UsClientError("invalid_response");
      }
      if (!response.ok) {
        if (
          response.status === 503 &&
          path === profilePath &&
          method === "GET" &&
          z.object({ code: z.literal("traceability_profile_not_provisioned") }).safeParse(value)
            .success
        )
          throw new UsClientError("profile_not_provisioned");
        const errors: Record<number, UsClientErrorCode> = {
          401: "session_required",
          403: "forbidden",
          409: "conflict",
          429: "rate_limited",
        };
        throw new UsClientError(
          errors[response.status] ?? (response.status >= 500 ? "unavailable" : "request_rejected"),
        );
      }
      return checked(schema, value, "invalid_response");
    } catch (error) {
      if (error instanceof UsClientError) throw error;
      throw new UsClientError("unavailable");
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  return {
    deployment: () => request("/api/us/deployment", deploymentSchema),
    async session() {
      const data = await request("/api/us-auth/get-session", sessionSchema);
      return data
        ? { user: data.user, activeOrganizationId: data.session.activeOrganizationId ?? null }
        : null;
    },
    async signIn(input: unknown) {
      const body = checked(
        z.object({ email: z.email(), password: passwordSchema }).strict(),
        input,
        "invalid_input",
      );
      return request("/api/us-auth/sign-in/email", signedInSchema, "POST", body);
    },
    async enroll(input: unknown) {
      const body = checked(z.object({ password: passwordSchema }).strict(), input, "invalid_input");
      return request("/api/us-auth/two-factor/enable", enrollmentSchema, "POST", body);
    },
    async verifyTotp(input: unknown) {
      const body = checked(
        z.object({ code: z.string().regex(/^\d{6}$/) }).strict(),
        input,
        "invalid_input",
      );
      return request("/api/us-auth/two-factor/verify-totp", verificationSchema, "POST", body);
    },
    async verifyBackupCode(input: unknown) {
      const body = checked(
        z.object({ code: z.string().min(1).max(128) }).strict(),
        input,
        "invalid_input",
      );
      return request(
        "/api/us-auth/two-factor/verify-backup-code",
        verificationSchema,
        "POST",
        body,
      );
    },
    organizations: () => request("/api/us-auth/organization/list", z.array(organizationSchema)),
    async selectOrganization(input: unknown) {
      const body = checked(
        z.object({ organizationId: z.string().min(1).max(256) }).strict(),
        input,
        "invalid_input",
      );
      await request("/api/us-auth/organization/set-active", organizationSchema, "POST", body);
    },
    async signOut() {
      await request("/api/us-auth/sign-out", z.object({ success: z.literal(true) }), "POST", {});
    },
    profile: () => request(profilePath, usTraceabilityProfileSummarySchema),
    async provisionProfile(input: unknown) {
      return request(
        profilePath,
        usTraceabilityProfileSummarySchema,
        "PUT",
        checked(provisionUsTraceabilityProfileSchema, input, "invalid_input"),
      );
    },
  };
}

export type UsBrowserClient = ReturnType<typeof createUsBrowserClient>;
