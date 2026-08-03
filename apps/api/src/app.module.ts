import { Module, type DynamicModule } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import type { AuthSetup } from "./auth/auth.setup";
import { JobsModule } from "./jobs/jobs.module";
import { OrgProfileModule } from "./modules/org-profile/org-profile.module";
import { CounterpartiesModule } from "./modules/counterparties/counterparties.module";
import { ProductsModule } from "./modules/products/products.module";
import { LinesModule } from "./modules/lines/lines.module";
import { ShiftsModule } from "./modules/shifts/shifts.module";
import { LabelTemplatesModule } from "./modules/label-templates/label-templates.module";
import { StationDevicesModule } from "./modules/station-devices/station-devices.module";
import { StationScansModule } from "./modules/station-scans/station-scans.module";
import { EmployeesModule } from "./modules/employees/employees.module";
import { OperatorsModule } from "./modules/operators/operators.module";
import { KiosksModule } from "./modules/kiosks/kiosks.module";
import { PickupReasonsModule } from "./modules/pickup-reasons/pickup-reasons.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";
import { ApiKeysModule } from "./modules/api-keys/api-keys.module";
import { ExchangeModule } from "./modules/exchange/exchange.module";
import { KioskModule } from "./modules/kiosk/kiosk.module";
import { PickupOrdersModule } from "./modules/pickup-orders/pickup-orders.module";
import { ConflictsModule } from "./modules/conflicts/conflicts.module";
import { PickupRejectionsModule } from "./modules/pickup-rejections/pickup-rejections.module";
import { SsccModule } from "./modules/sscc/sscc.module";
import { BoxesModule } from "./modules/boxes/boxes.module";
import { BoxExceptionsModule } from "./modules/box-exceptions/box-exceptions.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { loadEnv, type Env } from "./env";
import { TeamModule } from "./modules/team/team.module";
import { InvitationsModule } from "./modules/invitations/invitations.module";
import { StorageModule } from "./modules/storage/storage.module";
import { ProfileModule } from "./modules/profile/profile.module";

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
    setup: Pick<AuthSetup, "auth" | "db" | "pool"> & { databaseUrl: string; env?: Env },
  ): DynamicModule {
    const env = setup.env ?? loadEnv();
    return {
      module: AppModule,
      imports: [
        AuthModule.forRoot(setup),
        AuthorizationModule,
        JobsModule.forRoot(setup.databaseUrl, env),
        OrgProfileModule,
        CounterpartiesModule,
        ProductsModule,
        LinesModule,
        ShiftsModule,
        LabelTemplatesModule,
        StationDevicesModule,
        StationScansModule,
        EmployeesModule,
        OperatorsModule,
        KiosksModule,
        PickupReasonsModule,
        IntegrationsModule,
        ApiKeysModule,
        ExchangeModule,
        KioskModule,
        PickupOrdersModule,
        ConflictsModule,
        PickupRejectionsModule,
        SsccModule,
        BoxesModule,
        BoxExceptionsModule,
        StorageModule.forRoot(env),
        TeamModule.forRoot(env.ADMIN_ORIGIN),
        InvitationsModule,
        ProfileModule,
      ],
      controllers: [HealthController],
    };
  }
}
