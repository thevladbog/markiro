import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { TenantBillingService } from "./tenant-billing.service";

@Controller("billing/invoices")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class TenantBillingController {
  constructor(private readonly billing: TenantBillingService) {}

  @Get()
  list(@Req() req: RequestWithTenant) {
    return this.billing.list(req.tenantId!);
  }

  @Get(":id")
  detail(@Req() req: RequestWithTenant, @Param("id") id: string) {
    return this.billing.detail(req.tenantId!, id);
  }

  @Get(":id/documents/:documentId/download")
  download(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("documentId") documentId: string,
  ) {
    return this.billing.download(req.tenantId!, id, documentId);
  }
}
