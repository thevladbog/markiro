import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  type SchemaObject,
} from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { z } from "zod";
import {
  ApiCabinetAuth,
  ApiHttpErrors,
  ApiZodBody,
  ApiZodValidationError,
} from "../../lib/openapi";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  AllowSubscriptionReadOnly,
  RequireFeature,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { ApiKeysService, type ApiKeyIssuedDto, type ApiKeySummaryDto } from "./api-keys.service";

/** POST /integrations/public_api/keys body. */
const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
});
type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

const apiKeySummaryListOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["keys"],
  properties: {
    keys: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "kind", "createdAt", "lastRequest"],
        properties: {
          id: { type: "string" },
          name: { type: "string", nullable: true },
          kind: { type: "string", enum: ["public"] },
          createdAt: { type: "string", format: "date-time" },
          lastRequest: { type: "string", format: "date-time", nullable: true },
        },
      },
    },
  },
};

const apiKeyIssuedOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "key"],
  properties: {
    id: { type: "string" },
    key: { type: "string", description: "One-time plaintext key reveal; never returned again." },
  },
};

/**
 * Публичный API ключ — канал `public_api` без расписания (бриф Task 11):
 * его "настройки" это список ключей, а "журнал" это выпуск и отзыв.
 * Маршруты закреплены под литеральным `public_api/keys`, а не под общим
 * `:type` из `IntegrationsController`, потому что выпуск/отзыв ключей — это
 * операция, которая существует только для этого одного канала. Кабинетный
 * раздел: `TenantGuard` + `AuthorizationGuard`, ключ станции или киоска сюда
 * не доходит (docs/device-key-surface.md).
 */
@ApiTags("integrations")
@Controller("integrations/public_api/keys")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
@ApiCabinetAuth()
export class ApiKeysController {
  constructor(
    private readonly service: ApiKeysService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List public API keys" })
  @ApiOkResponse({ schema: apiKeySummaryListOpenApiSchema })
  @ApiHttpErrors(401, 403)
  async list(@Req() req: RequestWithTenant): Promise<{ keys: ApiKeySummaryDto[] }> {
    return this.service.list(req.tenantId!);
  }

  // Секрет отдаётся ровно здесь и ровно один раз — ApiKeySummaryDto (list) его
  // никогда не несёт (docs/device-key-surface.md).
  @Post()
  @RequireFeature("publicApi")
  @ApiOperation({
    summary: "Issue a public API key",
    description: "The plaintext key is revealed exactly once, in this response.",
  })
  @ApiZodBody(createApiKeySchema)
  @ApiCreatedResponse({ schema: apiKeyIssuedOpenApiSchema })
  @ApiZodValidationError()
  @ApiHttpErrors(401, 403)
  async create(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyDto,
  ): Promise<ApiKeyIssuedDto> {
    const result = await this.service.create(req.tenantId!, req.userId!, body.name);
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "public_api_key.issue",
      resourceId: result.id,
      outcome: "succeeded",
    });
    return result;
  }

  @Delete(":id")
  @HttpCode(204)
  @AllowSubscriptionReadOnly("security")
  @ApiOperation({ summary: "Revoke a public API key" })
  @ApiParam({ name: "id", description: "Better Auth api-key id." })
  @ApiResponse({ status: 204, description: "The key was revoked." })
  @ApiHttpErrors(401, 403, 404)
  async revoke(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    await this.service.revoke(req.tenantId!, id);
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "public_api_key.revoke",
      resourceId: id,
      outcome: "succeeded",
    });
  }
}
