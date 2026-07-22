import { Global, Module, type DynamicModule } from "@nestjs/common";
import type { AuthSetup } from "./auth.setup";

export const AUTH = "AUTH";
export const DB = "DB";

/**
 * Wraps the already-constructed Better Auth instance and Drizzle db handle
 * (built once in main.ts via setupAuth) as injectable Nest providers, so
 * later feature modules (tenant guard, etc.) can inject them by token
 * instead of re-constructing the connection.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(setup: Pick<AuthSetup, "auth" | "db">): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        { provide: AUTH, useValue: setup.auth },
        { provide: DB, useValue: setup.db },
      ],
      exports: [AUTH, DB],
    };
  }
}
