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
import { CABINET_CAPABILITY } from "@markiro/domain";
import { RequirePermissions } from "../../authorization/access-policy";
import { AuthorizationGuard } from "../../authorization/authorization.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
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
 * Admin-only management of station access. Cabinet authorization keeps a station
 * api-key out: a floor device must never be able to mint or revoke operator
 * credentials, even though `TenantGuard` accepts its key for tenant resolution.
 */
@ApiTags("operators")
@Controller("operators")
@UseGuards(TenantGuard, AuthorizationGuard)
export class OperatorsController {
  constructor(private readonly operatorsService: OperatorsService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listOperators(@Req() req: RequestWithTenant): Promise<ListOperatorsResponseDto> {
    return this.operatorsService.listOperators(req.tenantId!);
  }

  @Put(":employeeId")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async grantAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body(new ZodValidationPipe(grantStationAccessSchema)) body: GrantStationAccessDto,
  ): Promise<StationAccessDto> {
    return this.operatorsService.grantAccess(req.tenantId!, employeeId, body);
  }

  @Patch(":employeeId")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
    @Body(new ZodValidationPipe(updateStationAccessSchema)) body: UpdateStationAccessDto,
  ): Promise<StationAccessDto> {
    return this.operatorsService.updateAccess(req.tenantId!, employeeId, body);
  }

  @Delete(":employeeId")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async revokeAccess(
    @Req() req: RequestWithTenant,
    @Param("employeeId", new ParseUUIDPipe()) employeeId: string,
  ): Promise<void> {
    return this.operatorsService.revokeAccess(req.tenantId!, employeeId);
  }
}
