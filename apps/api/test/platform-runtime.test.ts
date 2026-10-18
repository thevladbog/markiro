import { expect, it } from "vitest";
import { ModulesContainer } from "@nestjs/core";
import { createApplication } from "../src/main";
import { loadEnv } from "../src/env";
import { DB_POOL } from "../src/auth/auth.module";
import type { createDb } from "@markiro/db";
import { setupAuth } from "../src/auth/auth.setup";
import { InvitationAdvisoryLockPool } from "../src/modules/invitations/invitation-advisory-lock-pool.service";
import { PLATFORM_TEST_ENV } from "./support/platform-test-env";

it("production platform bootstrap shares a six-connection pool with platform authentication", async () => {
  const app = await createApplication(
    loadEnv({
      ...PLATFORM_TEST_ENV,
      SERVER_PROFILE: "platform-only",
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    }),
  );
  try {
    const pool = app.get<ReturnType<typeof createDb>["pool"]>(DB_POOL);
    expect(pool.options.max).toBe(6);
    expect(pool.totalCount).toBe(0);
    expect(
      [...app.get(ModulesContainer).values()].some((module) =>
        module.providers.has(InvitationAdvisoryLockPool),
      ),
    ).toBe(false);
  } finally {
    await app.close();
  }
});

it("legacy auth keeps its existing ten-connection pool default", async () => {
  const setup = setupAuth(
    loadEnv({
      ...PLATFORM_TEST_ENV,
      DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
      BETTER_AUTH_SECRET: "legacy-placeholder-0000",
      BETTER_AUTH_URL: "http://localhost:3000",
      PAIRING_CODE_PEPPER: "legacy-pepper-placeholder",
    }),
  );
  try {
    expect(setup.pool.options.max).toBe(10);
    expect(setup.pool.totalCount).toBe(0);
  } finally {
    await setup.pool.end();
  }
});
