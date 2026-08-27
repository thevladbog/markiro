import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  actDocumentParamsSchema,
  billingIdParamsSchema,
  invoiceDocumentParamsSchema,
  listDocumentsQuerySchema,
  listInvoicesQuerySchema,
  offerDocumentParamsSchema,
  type ListDocumentsQueryDto,
  type ListInvoicesQueryDto,
} from "./dto";
import { TenantBillingReadService } from "./tenant-billing-read.service";

@Controller("billing")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.BILLING_READ)
export class TenantBillingController {
  constructor(private readonly billing: TenantBillingReadService) {}

  @Get("overview")
  overview(@Req() req: RequestWithTenant) {
    return this.billing.overview(req.tenantId!);
  }

  @Get("subscription")
  subscription(@Req() req: RequestWithTenant) {
    return this.billing.subscription(req.tenantId!);
  }

  @Get("invoices")
  listInvoices(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listInvoicesQuerySchema)) query: ListInvoicesQueryDto,
  ) {
    return this.billing.listInvoices(req.tenantId!, query);
  }

  @Get("invoices/:id")
  invoiceDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.billing.invoiceDetail(req.tenantId!, params.id);
  }

  @Get("invoices/:id/documents/:documentId/download")
  downloadInvoiceDocument(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(invoiceDocumentParamsSchema))
    params: {
      id: string;
      documentId: string;
    },
  ) {
    return this.billing.downloadInvoiceDocument(req.tenantId!, params.id, params.documentId);
  }

  @Get("documents")
  listDocuments(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQueryDto,
  ) {
    return this.billing.listDocuments(req.tenantId!, query);
  }

  @Get("offers/:id")
  offerDetail(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(billingIdParamsSchema)) params: { id: string },
  ) {
    return this.billing.offerDetail(req.tenantId!, params.id);
  }

  @Get("offers/:id/documents/:documentId/download")
  downloadOfferDocument(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(offerDocumentParamsSchema))
    params: {
      id: string;
      documentId: string;
    },
  ) {
    return this.billing.downloadOfferDocument(req.tenantId!, params.id, params.documentId);
  }

  @Get("acts/:id/documents/:documentId/download")
  downloadActDocument(
    @Req() req: RequestWithTenant,
    @Param(new ZodValidationPipe(actDocumentParamsSchema))
    params: {
      id: string;
      documentId: string;
    },
  ) {
    return this.billing.downloadActDocument(req.tenantId!, params.id, params.documentId);
  }
}
