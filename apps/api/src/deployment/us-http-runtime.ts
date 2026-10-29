import type { UsAuth } from "../modules/traceability/auth/us-auth";

/** Transport dependencies only; this view grants no admission or construction authority. */
export type UsHttpRuntime = Readonly<{
  auth: UsAuth;
  assertDatabaseReady: () => Promise<void>;
  env: Readonly<{
    BETTER_AUTH_URL: string;
    ADMIN_ORIGIN: string;
  }>;
}>;
