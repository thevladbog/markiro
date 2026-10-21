import { Module, type DynamicModule } from "@nestjs/common";
import { PlatformLeadsController } from "./platform-leads.controller";
import { PlatformLeadsService } from "./platform-leads.service";

/**
 * The «Заявки» section of the SaaS admin (spec §15.6). It takes the application's own
 * `PlatformTenantsModule` instance for provisioning: a second `forRoot` would mount
 * the tenant controller twice.
 */
@Module({})
export class PlatformLeadsModule {
  static forRoot(platformTenants: DynamicModule): DynamicModule {
    return {
      module: PlatformLeadsModule,
      imports: [platformTenants],
      controllers: [PlatformLeadsController],
      providers: [PlatformLeadsService],
    };
  }
}
