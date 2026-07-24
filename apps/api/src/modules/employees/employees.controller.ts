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
@UseGuards(TenantGuard)
export class EmployeesController {
  constructor(private readonly employeesService: EmployeesService) {}

  @Get()
  async listEmployees(
    @Req() req: RequestWithTenant,
    @Query(new ZodValidationPipe(listEmployeesQuerySchema)) query: ListEmployeesQueryDto,
  ): Promise<ListEmployeesResponseDto> {
    return this.employeesService.listEmployees(req.tenantId!, query);
  }

  @Post()
  async createEmployee(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.createEmployee(req.tenantId!, body);
  }

  @Patch(":id")
  async updateEmployee(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.updateEmployee(req.tenantId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  async archiveEmployee(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.employeesService.archiveEmployee(req.tenantId!, id);
  }

  @Post(":id/badges")
  async issueBadge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(issueBadgeSchema)) body: IssueBadgeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.issueBadge(req.tenantId!, id, body);
  }

  @Delete(":id/badges/:badgeId")
  @HttpCode(204)
  async revokeBadge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("badgeId") badgeId: string,
  ): Promise<void> {
    return this.employeesService.revokeBadge(req.tenantId!, id, badgeId);
  }
}
