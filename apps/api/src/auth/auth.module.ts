import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnModuleDestroy,
} from "@nestjs/common";
import type { AuthSetup } from "./auth.setup";

export const AUTH = "AUTH";
export const DB = "DB";
const POOL = "AUTH_POOL";

// Reuses setupAuth's own `pool` type by reference instead of importing
// `pg.Pool` directly (that type lives in @markiro/db's own node_modules and
// isn't portably nameable from this package's .d.ts -- see the TS2883 note
// in packages/db/src/auth-config.ts and the DbConnection note in
// auth.setup.ts for the same class of issue).
type Pool = AuthSetup["pool"];

/**
 * Nothing else in the app closes the pg.Pool created by `setupAuth` --
 * without this, the process (or the e2e test's app.close()) would leave the
 * pool's sockets open. Registered as a provider (rather than closed
 * directly in main.ts) so it closes via Nest's normal shutdown lifecycle
 * (see main.ts's `enableShutdownHooks`), same as PgBossService.
 */
@Injectable()
class AuthPoolCloser implements OnModuleDestroy {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Wraps the already-constructed Better Auth instance and Drizzle db handle
 * (built once in main.ts via setupAuth) as injectable Nest providers, so
 * later feature modules (tenant guard, etc.) can inject them by token
 * instead of re-constructing the connection.
 */
@Global()
@Module({})
export class AuthModule {
  static forRoot(setup: Pick<AuthSetup, "auth" | "db" | "pool">): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        { provide: AUTH, useValue: setup.auth },
        { provide: DB, useValue: setup.db },
        { provide: POOL, useValue: setup.pool },
        AuthPoolCloser,
      ],
      exports: [AUTH, DB],
    };
  }
}
