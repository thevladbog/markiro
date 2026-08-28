import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags, type SchemaObject } from "@nestjs/swagger";
import { CABINET_CAPABILITY, type CabinetCapability, type CabinetRole } from "@markiro/domain";
import { ApiCabinetAuth, ApiHttpErrors } from "../lib/openapi";
import { TenantGuard, type RequestWithTenant } from "../tenancy/tenant.guard";
import { RequireMembership } from "./access-policy";
import { AuthorizationGuard } from "./authorization.guard";
import { AuthorizationService, type AccessDocumentSubscription } from "./authorization.service";

export interface AccessDocumentDto {
  roles: CabinetRole[];
  capabilities: CabinetCapability[];
  subscription: AccessDocumentSubscription["subscription"];
  scheduled: AccessDocumentSubscription["scheduled"];
  usage: AccessDocumentSubscription["usage"];
  quotas: AccessDocumentSubscription["quotas"];
  features: AccessDocumentSubscription["features"];
}

const dateTimeSchema = { type: "string", format: "date-time" } as const;
const uuidSchema = { type: "string", format: "uuid" } as const;

const accessSubscriptionOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["access", "status", "startsAt", "endsAt", "plan", "addons"],
  properties: {
    access: { type: "string", enum: ["managed", "read_only", "unmanaged"] },
    status: {
      type: "string",
      enum: ["unmanaged", "pending_activation", "trial", "active", "expired", "read_only"],
    },
    startsAt: { ...dateTimeSchema, nullable: true },
    endsAt: { ...dateTimeSchema, nullable: true },
    plan: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["id", "version", "nameRu", "nameEn"],
      properties: {
        id: uuidSchema,
        version: { type: "integer", minimum: 1 },
        nameRu: { type: "string" },
        nameEn: { type: "string" },
      },
    },
    addons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["catalogVersionId", "quantity", "quotas", "features"],
        properties: {
          catalogVersionId: uuidSchema,
          quantity: { type: "integer", minimum: 0 },
          quotas: { type: "object", additionalProperties: { type: "integer" } },
          features: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const accessDocumentOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["roles", "capabilities", "subscription", "scheduled", "usage", "quotas", "features"],
  properties: {
    roles: {
      type: "array",
      items: { type: "string", enum: ["owner", "admin", "manager", "member"] },
    },
    capabilities: {
      type: "array",
      items: { type: "string", enum: Object.values(CABINET_CAPABILITY) },
    },
    subscription: accessSubscriptionOpenApiSchema,
    scheduled: {
      ...accessSubscriptionOpenApiSchema,
      nullable: true,
      properties: { ...accessSubscriptionOpenApiSchema.properties, startsAt: dateTimeSchema },
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["lines", "stations", "kiosks", "cabinetUsers"],
      properties: {
        lines: { type: "integer", minimum: 0 },
        stations: { type: "integer", minimum: 0 },
        kiosks: { type: "integer", minimum: 0 },
        cabinetUsers: { type: "integer", minimum: 0 },
      },
    },
    quotas: { type: "object", additionalProperties: { type: "integer", nullable: true } },
    features: { type: "object", additionalProperties: { type: "boolean" } },
  },
};

@ApiTags("access")
@Controller("access")
@UseGuards(TenantGuard, AuthorizationGuard)
@ApiCabinetAuth()
export class AccessController {
  constructor(private readonly authorization: AuthorizationService) {}

  @Get("me")
  @RequireMembership()
  @ApiOperation({
    summary: "Get current cabinet access document",
    description:
      "The caller's roles and capabilities in the active tenant, plus the resolved subscription " +
      "entitlements (current and scheduled subscription, usage, quotas, feature flags).",
  })
  @ApiOkResponse({ schema: accessDocumentOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async me(@Req() request: RequestWithTenant): Promise<AccessDocumentDto> {
    const principal = request.cabinetPrincipal!;
    return {
      roles: principal.roles,
      capabilities: principal.capabilities,
      ...(await this.authorization.resolveSubscriptionDocument(principal.tenantId)),
    };
  }
}
