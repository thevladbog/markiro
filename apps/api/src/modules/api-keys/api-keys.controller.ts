import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { z } from "zod";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import { ApiKeysService, type ApiKeyIssuedDto, type ApiKeySummaryDto } from "./api-keys.service";

/** POST /integrations/public_api/keys body. */
const createApiKeySchema = z.object({
  name: z.string().min(1).max(200),
});
type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

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
@UseGuards(TenantGuard, AuthorizationGuard)
@RequirePermissions(CABINET_CAPABILITY.CREDENTIALS_MANAGE)
export class ApiKeysController {
  constructor(
    private readonly service: ApiKeysService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  async list(@Req() req: RequestWithTenant): Promise<{ keys: ApiKeySummaryDto[] }> {
    return this.service.list(req.tenantId!);
  }

  // Секрет отдаётся ровно здесь и ровно один раз — ApiKeySummaryDto (list) его
  // никогда не несёт (docs/device-key-surface.md).
  @Post()
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
