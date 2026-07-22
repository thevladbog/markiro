import { Module, type DynamicModule } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import type { AuthSetup } from "./auth/auth.setup";
import { JobsModule } from "./jobs/jobs.module";
import { OrgProfileModule } from "./modules/org-profile/org-profile.module";

@Module({ controllers: [HealthController] })
export class AppModule {
  /**
   * Registers the already-constructed auth/db instances (see
   * `setupAuth` in `auth/auth.setup.ts`) as injectable providers via
   * `AuthModule`, boots the pg-boss partition job via `JobsModule`
   * (needs the raw `databaseUrl` for its own connection, separate from the
   * Drizzle `db`), and wires up tenant-guarded feature modules (OrgProfile,
   * and later plan-03 tasks) that depend on the `DB`/`AUTH` tokens. Used by
   * `main.ts` and by tests that exercise the auth routes; plain
   * `imports: [AppModule]` (e.g. the health e2e test) keeps working without
   * a DB connection since it never needs AUTH/DB/jobs/feature modules.
   */
  static forRoot(
    setup: Pick<AuthSetup, "auth" | "db" | "pool"> & { databaseUrl: string },
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [AuthModule.forRoot(setup), JobsModule.forRoot(setup.databaseUrl), OrgProfileModule],
      controllers: [HealthController],
    };
  }
}
