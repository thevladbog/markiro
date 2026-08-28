import { Module, type DynamicModule } from "@nestjs/common";
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
import { DevicesModule } from "./modules/devices/devices.module";
import { StationPairingModule } from "./modules/station-pairing/station-pairing.module";
import { StationScansModule } from "./modules/station-scans/station-scans.module";
import { EmployeesModule } from "./modules/employees/employees.module";
import { OperatorsModule } from "./modules/operators/operators.module";
import { KiosksModule } from "./modules/kiosks/kiosks.module";
import { PickupReasonsModule } from "./modules/pickup-reasons/pickup-reasons.module";
import { DisaggregationReasonsModule } from "./modules/disaggregation-reasons/disaggregation-reasons.module";
import { DisaggregationModule } from "./modules/disaggregation/disaggregation.module";
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
import { CodeSearchModule } from "./modules/code-search/code-search.module";
import { AuthorizationModule } from "./authorization/authorization.module";
import { loadEnv, type Env } from "./env";
import { TeamModule } from "./modules/team/team.module";
import { InvitationsModule } from "./modules/invitations/invitations.module";
import { StorageModule } from "./modules/storage/storage.module";
import { ProfileModule } from "./modules/profile/profile.module";
import { TenantOwnerActivationModule } from "./modules/tenant-owner-activation/tenant-owner-activation.module";
import { PlatformAuthModule } from "./platform-auth/platform-auth.module";
import { PlatformCatalogModule } from "./modules/platform-catalog/platform-catalog.module";
import { PlatformTenantsModule } from "./modules/platform-tenants/platform-tenants.module";
import { PlatformOffersModule } from "./modules/platform-offers/platform-offers.module";
import { BillingProfilesModule } from "./modules/billing-profiles/billing-profiles.module";
import { BillingAccountsModule } from "./modules/billing-accounts/billing-accounts.module";
import { BillingModule } from "./modules/billing/billing.module";
import { BillingPaymentsModule } from "./modules/billing-payments/billing-payments.module";
import { BillingActsModule } from "./modules/billing-acts/billing-acts.module";
import { PlatformBillingRequestsModule } from "./modules/platform-billing-requests/platform-billing-requests.module";
import { TenantBillingModule } from "./modules/tenant-billing/tenant-billing.module";
import { PlatformOperationsModule } from "./modules/platform-operations/platform-operations.module";
import type { PlatformAuth } from "@markiro/db";
import { SubscriptionsModule } from "./subscriptions/subscriptions.module";
import { ShiftExportsModule } from "./modules/shift-exports/shift-exports.module";
import { StationShiftCloseModule } from "./modules/station-shift-close/station-shift-close.module";
import { DemoRequestsModule } from "./modules/demo-requests/demo-requests.module";
import { PlatformHttpModule } from "./platform-http/platform-http.module";
import { HealthModule } from "./health/health.module";

@Module({})
export class AppModule {
  /**
   * Registers the already-constructed auth/db instances (see
   * `setupAuth` in `auth/auth.setup.ts`) as injectable providers via
   * `AuthModule`, boots the pg-boss partition job via `JobsModule`
   * (needs the raw `databaseUrl` for its own connection, separate from the
   * Drizzle `db`), and wires up tenant-guarded feature modules (OrgProfile,
   * and later plan-03 tasks) that depend on the `DB`/`AUTH` tokens. Used by
   * `main.ts` and by tests that exercise production dependencies. Health
   * route tests instantiate the controller with a fake readiness service,
   * keeping liveness tests independent from external infrastructure.
   */
  static forRoot(
    setup: Pick<AuthSetup, "auth" | "db" | "pool"> & {
      platformAuth?: PlatformAuth;
      databaseUrl: string;
      env?: Env;
    },
  ): DynamicModule {
    const env = setup.env ?? loadEnv();
    return {
      module: AppModule,
      imports: [
        PlatformHttpModule,
        AuthModule.forRoot(setup),
        ...(setup.platformAuth
          ? [
              PlatformAuthModule.forRoot(setup.platformAuth, env.SAAS_ADMIN_ORIGIN),
              PlatformCatalogModule,
              PlatformTenantsModule.forRoot(env.ADMIN_ORIGIN),
              PlatformOffersModule,
              BillingProfilesModule,
              BillingAccountsModule,
              BillingModule,
              BillingPaymentsModule,
              BillingActsModule,
              PlatformBillingRequestsModule,
              PlatformOperationsModule.forRoot(env),
            ]
          : []),
        AuthorizationModule,
        SubscriptionsModule.forRoot(env.SUBSCRIPTION_ENFORCEMENT_MODE),
        TenantBillingModule.forRoot(env.ADMIN_ORIGIN),
        JobsModule.forRoot(setup.databaseUrl, env),
        DemoRequestsModule.forRoot(env),
        OrgProfileModule,
        CounterpartiesModule,
        ProductsModule,
        LinesModule,
        ShiftsModule,
        ShiftExportsModule,
        StationShiftCloseModule,
        LabelTemplatesModule,
        StationDevicesModule,
        DevicesModule,
        StationPairingModule,
        StationScansModule,
        EmployeesModule,
        OperatorsModule,
        KiosksModule,
        PickupReasonsModule,
        DisaggregationReasonsModule,
        DisaggregationModule,
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
        CodeSearchModule,
        StorageModule.forRoot(env),
        TeamModule.forRoot(env.ADMIN_ORIGIN),
        InvitationsModule.forRoot(setup.databaseUrl),
        ProfileModule,
        TenantOwnerActivationModule,
        HealthModule.forRoot(),
      ],
      controllers: [],
      providers: [],
    };
  }
}
