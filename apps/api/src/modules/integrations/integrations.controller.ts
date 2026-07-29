import { Body, Controller, Get, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import type { IntegrationChannelType } from "./channel-registry";
import type { ChannelDetailDto, ChannelSummaryDto, JournalPageDto } from "./dto";
import { IntegrationsService } from "./integrations.service";

// Кабинетный раздел: ключ станции или киоска сюда не доходит
// (docs/device-key-surface.md).
@ApiTags("integrations")
@Controller("integrations")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  async list(@Req() req: RequestWithTenant): Promise<{ channels: ChannelSummaryDto[] }> {
    return this.integrations.listChannels(req.tenantId!, new Date());
  }

  @Get(":type")
  async detail(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
  ): Promise<ChannelDetailDto> {
    return this.integrations.getChannel(req.tenantId!, type, new Date());
  }

  @Patch(":type")
  async update(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
    @Body() body: Record<string, unknown>,
  ): Promise<ChannelDetailDto> {
    await this.integrations.updateChannel(req.tenantId!, type, body);
    return this.integrations.getChannel(req.tenantId!, type, new Date());
  }

  @Get(":type/journal")
  async journal(
    @Req() req: RequestWithTenant,
    @Param("type") type: IntegrationChannelType,
  ): Promise<JournalPageDto> {
    return this.integrations.readJournal(req.tenantId!, type);
  }
}
