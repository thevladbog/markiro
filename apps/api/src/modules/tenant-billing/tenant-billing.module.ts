import { Global, Module, type DynamicModule } from "@nestjs/common";
import { TenantBillingController } from "./tenant-billing.controller";
import { TenantBillingOffersService } from "./tenant-billing-offers.service";
import { TenantBillingReadService } from "./tenant-billing-read.service";
import { TenantBillingRequestsService } from "./tenant-billing-requests.service";
import {
  TENANT_BILLING_ADMIN_ORIGIN,
  TenantBillingNotificationsService,
} from "./tenant-billing-notifications.service";

@Global()
@Module({})
export class TenantBillingModule {
  static forRoot(adminOrigin: string): DynamicModule {
    return {
      module: TenantBillingModule,
      controllers: [TenantBillingController],
      providers: [
        TenantBillingReadService,
        TenantBillingRequestsService,
        TenantBillingOffersService,
        TenantBillingNotificationsService,
        { provide: TENANT_BILLING_ADMIN_ORIGIN, useValue: adminOrigin },
      ],
      exports: [TenantBillingNotificationsService],
    };
  }
}
