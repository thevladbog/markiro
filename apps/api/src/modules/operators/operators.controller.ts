import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { SessionOnlyGuard } from "../../tenancy/session-only.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  grantStationAccessSchema,
  updateStationAccessSchema,
  type GrantStationAccessDto,
  type ListOperatorsResponseDto,
  type StationAccessDto,
  type UpdateStationAccessDto,
} from "./dto";
import { OperatorsService } from "./operators.service";

/**
 * Admin-only management of station access. `SessionOnlyGuard` keeps a station
 * api-key out: a floor device must never be able to mint or revoke operator
 * credentials, even though `TenantGuard` accepts its key for tenant resolution.
 */
@ApiTags("operators")
@Controller("operators")
@UseGuards(TenantGuard, SessionOnlyGuard)
export class OperatorsController {
  constructor(private readonly operatorsService: OperatorsService) {}

  @Get()
  async listOperators(@Req() req: RequestWithTenant): Promise<ListOperatorsResponseDto> {
    return this.operatorsService.listOperators(req.tenantId!);
  }

  @Put(":employeeId")
  async grantAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body(new ZodValidationPipe(grantStationAccessSchema)) body: GrantStationAccessDto,
  ): Promise<StationAccessDto> {
    return this.operatorsService.grantAccess(req.tenantId!, employeeId, body);
  }

  @Patch(":employeeId")
  async updateAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body(new ZodValidationPipe(updateStationAccessSchema)) body: UpdateStationAccessDto,
  ): Promise<StationAccessDto> {
    return this.operatorsService.updateAccess(req.tenantId!, employeeId, body);
  }

  @Delete(":employeeId")
  @HttpCode(204)
  async revokeAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
  ): Promise<void> {
    return this.operatorsService.revokeAccess(req.tenantId!, employeeId);
  }
}
