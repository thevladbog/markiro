import { Module, type DynamicModule } from "@nestjs/common";
import { SubscriptionLifecycleService } from "../../subscriptions/subscription-lifecycle.service";
import { PlatformTenantsController } from "./platform-tenants.controller";
import { PlatformTenantsService } from "./platform-tenants.service";
import {
  TENANT_OWNER_ACTIVATION_BASE_URL,
  TenantProvisioningService,
} from "./tenant-provisioning.service";

@Module({})
export class PlatformTenantsModule {
  static forRoot(activationBaseUrl: string): DynamicModule {
    return {
      module: PlatformTenantsModule,
      controllers: [PlatformTenantsController],
      providers: [
        TenantProvisioningService,
        PlatformTenantsService,
        SubscriptionLifecycleService,
        { provide: TENANT_OWNER_ACTIVATION_BASE_URL, useValue: activationBaseUrl },
      ],
      exports: [TenantProvisioningService, PlatformTenantsService, SubscriptionLifecycleService],
    };
  }
}
