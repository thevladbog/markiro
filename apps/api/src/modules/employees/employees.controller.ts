import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  createEmployeeSchema,
  issueBadgeSchema,
  listEmployeesQuerySchema,
  updateEmployeeSchema,
  type CreateEmployeeDto,
  type EmployeeDto,
  type IssueBadgeDto,
  type ListEmployeesQueryDto,
  type ListEmployeesResponseDto,
  type UpdateEmployeeDto,
} from "./dto";
import { EmployeesService } from "./employees.service";

@ApiTags("employees")
@Controller("employees")
// Station never calls this module, and `EmployeeDto` carries plaintext badge
// codes — exactly what shipping only PBKDF2 hashes to devices (see the
// station roster mirror) is meant to prevent. Cabinet authorization keeps a
// station api-key out even though TenantGuard accepts it for tenant
// resolution.
@UseGuards(TenantGuard, AuthorizationGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_READ)
  async listEmployees(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listEmployeesQuerySchema)) query: ListEmployeesQueryDto,
  ): Promise<ListEmployeesResponseDto> {
    return this.employeesService.listEmployees(req.tenantId!, query);
  }

  @Post()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createEmployee(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.createEmployee(req.tenantId!, body);
  }

  @Patch(":id")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateEmployee(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.updateEmployee(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async archiveEmployee(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.employeesService.archiveEmployee(req.tenantId!, id);
  }

  @Post(":id/badges")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async issueBadge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(issueBadgeSchema)) body: IssueBadgeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.issueBadge(req.tenantId!, id, body);
  }

  @Delete(":id/badges/:badgeId")
  @HttpCode(204)
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async revokeBadge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("badgeId") badgeId: string,
  ): Promise<void> {
    return this.employeesService.revokeBadge(req.tenantId!, id, badgeId);
  }
}
