import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { SecurityAuditService } from "../../authorization/security-audit.service";
import { RequireSubscriptionWrite } from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import type { IntegrationChannelType } from "./channel-registry";
import {
  linkCandidateSchema,
  listCandidatesQuerySchema,
  updateChannelSchema,
  type CandidatesPageDto,
  type ChannelDetailDto,
  type ChannelSummaryDto,
  type CredentialsIssuedDto,
  type JournalPageDto,
  type LinkCandidateDto,
  type ListCandidatesQueryDto,
  type UpdateChannelDto,
} from "./dto";
import { IntegrationsService } from "./integrations.service";

// Кабинетный раздел: ключ станции или киоска сюда не доходит
// (docs/device-key-surface.md).
@ApiTags("integrations")
@Controller("integrations")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly audit: SecurityAuditService,
  ) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_READ)
  async list(@Req() req: RequestWithTenant): Promise<{ channels: ChannelSummaryDto[] }> {
    return this.integrations.listChannels(req.tenantId!, new Date());
  }

  @Get(":type")
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_READ)
  async detail(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
  ): Promise<ChannelDetailDto> {
    return this.integrations.getChannel(req.tenantId!, type, new Date());
  }

  @Patch(":type")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE)
  async update(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
    // Review fix (PR #32, item 8): a bare `@Body() body: Record<string,
    // unknown>` was only ever a TypeScript annotation -- nothing checked that
    // the actual JSON body was an object at all. A non-object body (an
    // array, a bare string, `null`) reached `updateChannel`'s destructuring
    // (`const { silentAfterHours, ...settingsPatch } = patch`), which throws
    // outright for `null` and does something unintended for the rest, rather
    // than the clean 400 every other body-validated route in this file
    // already gives (`linkCandidate`, `listCandidates`). `updateChannelSchema`
    // (dto.ts) already rejects anything that isn't a plain object; wiring the
    // same `ZodValidationPipe` this file uses elsewhere is all that was
    // missing.
    @Body(new ZodValidationPipe(updateChannelSchema)) body: UpdateChannelDto,
  ): Promise<ChannelDetailDto> {
    await this.integrations.updateChannel(req.tenantId!, type, body);
    return this.integrations.getChannel(req.tenantId!, type, new Date());
  }

  @Get(":type/journal")
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_READ)
  async journal(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
  ): Promise<JournalPageDto> {
    return this.integrations.readJournal(req.tenantId!, type);
  }

  // Секрет отдаётся ровно здесь и ровно один раз — ChannelDetailDto его
  // никогда не несёт (docs/device-key-surface.md).
  @Post(":type/credentials")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE, CABINET_CAPABILITY.CREDENTIALS_MANAGE)
  async issueCredentials(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
  ): Promise<CredentialsIssuedDto> {
    const result = await this.integrations.issueCredentials(req.tenantId!, type);
    this.audit.credentialMutation({
      tenantId: req.tenantId!,
      userId: req.userId!,
      action: "integration_credentials.issue",
      resourceId: type,
      outcome: "succeeded",
    });
    return result;
  }

  @Get(":type/candidates")
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_READ)
  async listCandidates(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
    @Query(new ZodValidationPipe(listCandidatesQuerySchema)) query: ListCandidatesQueryDto,
  ): Promise<CandidatesPageDto> {
    return this.integrations.listCandidates(req.tenantId!, type, query.hidden === "true");
  }

  @Post(":type/candidates/:id/link")
  @HttpCode(HttpStatus.OK)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE)
  async linkCandidate(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(linkCandidateSchema)) body: LinkCandidateDto,
  ): Promise<void> {
    await this.integrations.linkCandidate(req.tenantId!, type, id, body.productId);
  }

  @Post(":type/candidates/:id/hide")
  @HttpCode(HttpStatus.OK)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE)
  async hideCandidate(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
    @Param("id") id: string,
  ): Promise<void> {
    await this.integrations.hideCandidate(req.tenantId!, type, id);
  }

  @Post(":type/candidates/:id/unhide")
  @HttpCode(HttpStatus.OK)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE)
  async unhideCandidate(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
    @Param("id") id: string,
  ): Promise<void> {
    await this.integrations.unhideCandidate(req.tenantId!, type, id);
  }
}

/**
 * Разрыв связи товара с внешней системой живёт в `/products`, а не в
 * `/integrations/:type/...`: `products.external_ref` не привязан к
 * конкретному каналу (в отличие от `integration_candidates`), так что этот
 * маршрут не может быть параметризован типом канала. Реализация всё равно
 * здесь, в модуле кандидатов (Task 10), а не в `ProductsController` —
 * разрыв связи это часть того же кабинетного API, что и связывание/скрытие.
 * `TenantGuard` + `AuthorizationGuard` — та же кабинетная граница
 * (docs/device-key-surface.md).
 */
@ApiTags("products")
@Controller("products")
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
export class ProductExternalLinkController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Delete(":id/external-link")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.INTEGRATIONS_WRITE)
  async unlink(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    await this.integrations.unlinkProduct(req.tenantId!, id);
  }
}
