import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";

import { CABINET_CAPABILITY } from "@markiro/domain";

import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard } from "../../tenancy/tenant.guard";
import {
  inventoryDocumentFormatsResponseOpenApiSchema,
  type InventoryDocumentFormatsResponseDto,
} from "./inventory-document-formats.dto";
import { InventoryDocumentFormatsService } from "./inventory-document-formats.service";

@ApiTags("inventory-documents")
@Controller("inventory-document-formats")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
export class InventoryDocumentFormatsController {
  constructor(private readonly formats: InventoryDocumentFormatsService) {}

  @Get()
  @ApiOkResponse({ schema: inventoryDocumentFormatsResponseOpenApiSchema })
  list(): InventoryDocumentFormatsResponseDto {
    return this.formats.list();
  }
}
