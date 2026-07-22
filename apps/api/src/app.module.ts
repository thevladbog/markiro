import { Module, type DynamicModule } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import type { AuthSetup } from "./auth/auth.setup";

@Module({ controllers: [HealthController] })
export class AppModule {
  /**
   * Registers the already-constructed auth/db instances (see
   * `setupAuth` in `auth/auth.setup.ts`) as injectable providers via
   * `AuthModule`. Used by `main.ts` and by tests that exercise the auth
   * routes; plain `imports: [AppModule]` (e.g. the health e2e test) keeps
   * working without a DB connection since it never needs AUTH/DB.
   */
  static forRoot(setup: Pick<AuthSetup, "auth" | "db">): DynamicModule {
    return {
      module: AppModule,
      imports: [AuthModule.forRoot(setup)],
      controllers: [HealthController],
    };
  }
}
