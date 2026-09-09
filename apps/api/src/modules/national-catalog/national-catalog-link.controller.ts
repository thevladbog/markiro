import {
  Body,
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Req,
  HttpCode,
  ParseUUIDPipe,
  UseGuards,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { z } from "zod";
import * as contracts from "@markiro/platform-contracts";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { ApiCabinetAuth, ApiHttpErrors, ApiZodBody, ApiZodResponse } from "../../lib/openapi";
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import type { ImportActor } from "./national-catalog-import.types";
import { NationalCatalogLinkService } from "./national-catalog-link.service";
function actor(req: RequestWithTenant): ImportActor {
  if (!req.tenantId || !req.userId) throw new UnauthorizedException();
  return { tenantId: req.tenantId, userId: req.userId };
}

@ApiTags("national-catalog-link")
@ApiCabinetAuth()
@Controller("products/:id/national-catalog")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
export class NationalCatalogLinkController {
  constructor(private readonly links: NationalCatalogLinkService) {}
  @Get("link")
  @ApiOperation({ summary: "Read the confirmed National Catalog link" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  @ApiZodResponse({ status: 200, schema: contracts.chzLinkDetailSchema })
  read(@Req() req: RequestWithTenant, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.links.readDetail(actor(req).tenantId, id);
  }
  @Post("link/refresh")
  @ApiOperation({ summary: "Request a confirmed National Catalog link refresh" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.importSessionRetrySchema)
  @ApiZodResponse({ status: 200, schema: contracts.chzSummarySchema })
  refresh(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(contracts.importSessionRetrySchema))
    _body: z.infer<typeof contracts.importSessionRetrySchema>,
  ) {
    return this.links.refresh(actor(req), id);
  }
  @Delete("link")
  @ApiOperation({ summary: "Remove a confirmed National Catalog link" })
  @HttpCode(200)
  @ApiHttpErrors(400, 401, 403, 404, 409, 410, 422)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  @RequireSubscriptionWrite()
  @ApiZodBody(contracts.chzLinkChangeSchema)
  @ApiZodResponse({ status: 200, schema: contracts.chzSummarySchema })
  remove(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(contracts.chzLinkChangeSchema))
    body: z.infer<typeof contracts.chzLinkChangeSchema>,
  ) {
    return this.links.remove(actor(req), id, body);
  }
}
