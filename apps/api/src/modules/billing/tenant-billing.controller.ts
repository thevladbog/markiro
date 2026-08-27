import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiCabinetAuth, ApiHttpErrors } from "../../lib/openapi";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import {
  tenantInvoiceDetailOpenApiSchema,
  tenantInvoiceDocumentDownloadOpenApiSchema,
  tenantInvoiceListOpenApiSchema,
} from "./dto";
import { TenantBillingService } from "./tenant-billing.service";

@ApiTags("tenant-billing")
@ApiCabinetAuth()
@Controller("billing/invoices")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class TenantBillingController {
  constructor(private readonly billing: TenantBillingService) {}

  @Get()
  @ApiOperation({ summary: "List tenant invoices" })
  @ApiOkResponse({ schema: tenantInvoiceListOpenApiSchema })
  @ApiHttpErrors(401, 403, 409)
  list(@Req() req: RequestWithTenant) {
    return this.billing.list(req.tenantId!);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a tenant invoice" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: tenantInvoiceDetailOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409)
  detail(@Req() req: RequestWithTenant, @Param("id") id: string) {
    return this.billing.detail(req.tenantId!, id);
  }

  @Get(":id/documents/:documentId/download")
  @ApiOperation({ summary: "Get an invoice document download link" })
  @ApiParam({ name: "id", schema: { type: "string", format: "uuid" } })
  @ApiParam({ name: "documentId", schema: { type: "string", format: "uuid" } })
  @ApiOkResponse({ schema: tenantInvoiceDocumentDownloadOpenApiSchema })
  @ApiHttpErrors(401, 403, 404, 409)
  download(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("documentId") documentId: string,
  ) {
    return this.billing.download(req.tenantId!, id, documentId);
  }
}
