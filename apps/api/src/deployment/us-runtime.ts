import {
  HttpException,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { createDb } from "@markiro/db";
import type { Env } from "../env";
import { createUsAuth, type UsAuth } from "../modules/traceability/auth/us-auth";
import { UsProfileStore } from "../modules/traceability/profile/us-profile-store";
import { UsMasterDataStore } from "../modules/traceability/master-data/us-master-data-store";

/** Owns only the explicitly supplied US pool; never imports RU application providers. */
export class UsRuntime implements OnApplicationShutdown {
  readonly auth: UsAuth;
  readonly profiles: UsProfileStore;
  readonly masterData: UsMasterDataStore;

  constructor(
    readonly env: Env,
    readonly connection: ReturnType<typeof createDb>,
  ) {
    this.auth = createUsAuth(connection.db, {
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      trustedOrigins: [env.ADMIN_ORIGIN],
    });
    this.profiles = new UsProfileStore(connection.db);
    this.masterData = new UsMasterDataStore(connection.db);
    // Idle-pool failures must not crash the metadata/liveness process or log SQL.
    connection.pool.on("error", () => {});
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connection.pool.end();
  }

  /** Read-only preflight. Startup never migrates, seeds or repairs a database. */
  async assertDatabaseReady(): Promise<void> {
    await this.databaseOperation(async () => {
      // LIMIT 0 validates the columns needed by the newest US migrations too.
      await this.connection.pool.query(`
        SELECT u.two_factor_enabled, f.failed_verification_count, f.locked_until,
               a.verified_at, p.baseline_version, o.time_zone, t.request_id
        FROM "user" u, us_two_factors f, us_session_assurances a,
             traceability_profiles p, org_profiles o, tenant_audit_events t,
             session, account, verification, organization, member, invitation
        LIMIT 0
      `);
    });
  }

  async databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: "us_database_unavailable" });
    }
  }
}
