import {
  platformLeadContracts,
  type PlatformLeadContacted,
  type PlatformLeadCreateTenant,
  type PlatformLeadLinkTenant,
  type PlatformLeadListQuery,
  type PlatformLeadUpdate,
} from "@markiro/platform-contracts";
import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { RequirePlatformCapabilities } from "../../platform-auth/platform-access-policy";
import type { RequestWithPlatformPrincipal } from "../../platform-auth/platform-auth.guard";
import { PlatformApiProtectedOk } from "../../platform-http/platform-openapi";
import { parsePlatformResponse } from "../../platform-http/platform-response";
import { ZodValidationPipe } from "../../zod.pipe";
import { PlatformLeadsService } from "./platform-leads.service";

const leadIdPipe = () => new ZodValidationPipe(platformLeadContracts.detail.params.shape.id);

@ApiTags("platform-leads")
@Controller("platform/leads")
export class PlatformLeadsController {
  constructor(private readonly leads: PlatformLeadsService) {}

  @Get()
  @ApiOperation({ summary: "List landing leads" })
  @PlatformApiProtectedOk({
    query: platformLeadContracts.list.query,
    response: platformLeadContracts.list.response,
  })
  @RequirePlatformCapabilities("leads.read")
  async list(
    @Query(new ZodValidationPipe(platformLeadContracts.list.query)) query: PlatformLeadListQuery,
  ) {
    return parsePlatformResponse(platformLeadContracts.list.response, await this.leads.list(query));
  }

  // Declared before `:id` so the literal segment is never parsed as a lead id.
  @Get("summary")
  @ApiOperation({ summary: "Count new landing leads for the navigation badge" })
  @PlatformApiProtectedOk({ response: platformLeadContracts.summary.response })
  @RequirePlatformCapabilities("leads.read")
  async summary() {
    return parsePlatformResponse(
      platformLeadContracts.summary.response,
      await this.leads.summary(),
    );
  }

  @Get(":id")
  @ApiOperation({ summary: "Read a landing lead with its journal" })
  @PlatformApiProtectedOk({ response: platformLeadContracts.detail.response })
  @RequirePlatformCapabilities("leads.read")
  async detail(@Param("id", leadIdPipe()) id: string) {
    return parsePlatformResponse(
      platformLeadContracts.detail.response,
      await this.leads.detail(id),
    );
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Change a lead's status, owner note or next touch",
    description: "A status change is journaled and written to the platform audit.",
  })
  @PlatformApiProtectedOk({
    body: platformLeadContracts.update.body,
    response: platformLeadContracts.update.response,
  })
  @RequirePlatformCapabilities("leads.write")
  async update(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", leadIdPipe()) id: string,
    @Body(new ZodValidationPipe(platformLeadContracts.update.body)) body: PlatformLeadUpdate,
  ) {
    return parsePlatformResponse(
      platformLeadContracts.update.response,
      await this.leads.update(request.platformPrincipal!, id, body),
    );
  }

  @Post(":id/contacted")
  @HttpCode(200)
  @ApiOperation({
    summary: "Record «Написал»: contacted and the next touch",
    description:
      "Moves a new lead to contacted and sets the next touch (default: three days later); later statuses are kept.",
  })
  @PlatformApiProtectedOk({
    body: platformLeadContracts.contacted.body,
    response: platformLeadContracts.contacted.response,
  })
  @RequirePlatformCapabilities("leads.write")
  async contacted(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", leadIdPipe()) id: string,
    @Body(new ZodValidationPipe(platformLeadContracts.contacted.body)) body: PlatformLeadContacted,
  ) {
    return parsePlatformResponse(
      platformLeadContracts.contacted.response,
      await this.leads.contacted(request.platformPrincipal!, id, body),
    );
  }

  @Post(":id/link-tenant")
  @HttpCode(200)
  @ApiOperation({ summary: "Link a lead to an existing tenant" })
  @PlatformApiProtectedOk({
    body: platformLeadContracts.linkTenant.body,
    response: platformLeadContracts.linkTenant.response,
  })
  @RequirePlatformCapabilities("leads.write")
  async linkTenant(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", leadIdPipe()) id: string,
    @Body(new ZodValidationPipe(platformLeadContracts.linkTenant.body))
    body: PlatformLeadLinkTenant,
  ) {
    return parsePlatformResponse(
      platformLeadContracts.linkTenant.response,
      await this.leads.linkTenant(request.platformPrincipal!, id, body.tenantId),
    );
  }

  @Post(":id/create-tenant")
  @HttpCode(200)
  @ApiOperation({
    summary: "Create a tenant without cabinet from the lead and link it",
    description: "Uses the regular tenant provisioning with cabinetAccess=none.",
  })
  @PlatformApiProtectedOk({
    body: platformLeadContracts.createTenant.body,
    response: platformLeadContracts.createTenant.response,
  })
  @RequirePlatformCapabilities("leads.write", "tenants.write")
  async createTenant(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", leadIdPipe()) id: string,
    @Body(new ZodValidationPipe(platformLeadContracts.createTenant.body))
    body: PlatformLeadCreateTenant,
  ) {
    return parsePlatformResponse(
      platformLeadContracts.createTenant.response,
      await this.leads.createTenant(request.platformPrincipal!, id, body),
    );
  }

  @Post(":id/anonymize")
  @HttpCode(200)
  @ApiOperation({
    summary: "Erase a lead's personal data",
    description: "Clears e-mail, name, phone, owner note and a personal INN; audited.",
  })
  @PlatformApiProtectedOk({ response: platformLeadContracts.anonymize.response })
  @RequirePlatformCapabilities("leads.write")
  async anonymize(
    @Req() request: RequestWithPlatformPrincipal,
    @Param("id", leadIdPipe()) id: string,
  ) {
    return parsePlatformResponse(
      platformLeadContracts.anonymize.response,
      await this.leads.anonymize(request.platformPrincipal!, id),
    );
  }
}
