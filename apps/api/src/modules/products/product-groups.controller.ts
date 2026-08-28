import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { SchemaObject } from "@nestjs/swagger";

import { ApiCabinetAuth, ApiHttpErrors } from "../../lib/openapi";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { RequireMembership } from "../../authorization/access-policy";
import { AllowSubscriptionReadOnly } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard } from "../../tenancy/tenant.guard";
import {
  ProductGroupsService,
  type ListChzProductGroupsResponseDto,
} from "./product-groups.service.js";

const chzProductGroupsOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "alias", "name"],
        properties: {
          code: { type: "integer" },
          alias: { type: "string" },
          name: { type: "string" },
        },
      },
    },
  },
};

@ApiTags("products")
@Controller("chz-product-groups")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@RequireMembership()
@AllowSubscriptionReadOnly("read")
export class ProductGroupsController {
  constructor(private readonly groups: ProductGroupsService) {}

  @Get()
  @ApiOperation({ summary: "List Chestny ZNAK product groups" })
  @ApiOkResponse({ schema: chzProductGroupsOpenApiSchema })
  @ApiHttpErrors(401, 403)
  @ApiCabinetAuth()
  list(): Promise<ListChzProductGroupsResponseDto> {
    return this.groups.list();
  }
}
