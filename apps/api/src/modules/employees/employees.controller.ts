import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import {
  AllowSubscriptionReadOnly,
  RequireSubscriptionWrite,
} from "../../subscriptions/subscription-access-policy";
import { SubscriptionAccessGuard } from "../../subscriptions/subscription-access.guard";
import { TenantGuard, type RequestWithTenant } from "../../tenancy/tenant.guard";
import { ZodValidationPipe } from "../../zod.pipe";
import {
  bulkEmployeePickupLimitsSchema,
  bulkEmployeePickupWriteoffSchema,
  createEmployeeSchema,
  employeePickupPolicySchema,
  issueBadgeSchema,
  listEmployeesQuerySchema,
  updateEmployeeSchema,
  type BulkEmployeePickupLimitsDto,
  type BulkEmployeePickupPolicyResponseDto,
  type BulkEmployeePickupWriteoffDto,
  type CreateEmployeeDto,
  type EmployeeDto,
  type IssueBadgeDto,
  type ListEmployeesQueryDto,
  type ListEmployeesResponseDto,
  type UpdateEmployeeDto,
  type UpdateEmployeePickupPolicyDto,
} from "./dto";
import { EmployeesService } from "./employees.service";

@ApiTags("employees")
@Controller("employees")
// Station never calls this module, and `EmployeeDto` carries plaintext badge
// codes — exactly what shipping only PBKDF2 hashes to devices (see the
// station roster mirror) is meant to prevent. Cabinet authorization keeps a
// station api-key out even though TenantGuard accepts it for tenant
// resolution.
@UseGuards(TenantGuard, AuthorizationGuard, SubscriptionAccessGuard)
@AllowSubscriptionReadOnly("read")
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
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async createEmployee(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(createEmployeeSchema)) body: CreateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.createEmployee(req.tenantId!, body);
  }

  @Patch("pickup-policy/limits")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async bulkUpdatePickupLimits(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(bulkEmployeePickupLimitsSchema))
    body: BulkEmployeePickupLimitsDto,
  ): Promise<BulkEmployeePickupPolicyResponseDto> {
    return this.employeesService.bulkUpdatePickupLimits(req.tenantId!, req.userId!, body);
  }

  @Patch("pickup-policy/writeoff-permission")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async bulkUpdatePickupWriteoff(
    @Req() req: RequestWithTenant,
    @Body(new ZodValidationPipe(bulkEmployeePickupWriteoffSchema))
    body: BulkEmployeePickupWriteoffDto,
  ): Promise<BulkEmployeePickupPolicyResponseDto> {
    return this.employeesService.bulkUpdatePickupWriteoff(req.tenantId!, req.userId!, body);
  }

  @Patch(":id")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updateEmployee(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateEmployeeSchema)) body: UpdateEmployeeDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.updateEmployee(req.tenantId!, id, body);
  }

  @Patch(":id/pickup-policy")
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async updatePickupPolicy(
    @Req() req: RequestWithTenant,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(employeePickupPolicySchema)) body: UpdateEmployeePickupPolicyDto,
  ): Promise<EmployeeDto> {
    return this.employeesService.updatePickupPolicy(req.tenantId!, req.userId!, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequireSubscriptionWrite()
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async archiveEmployee(@Req() req: RequestWithTenant, @Param("id") id: string): Promise<void> {
    return this.employeesService.archiveEmployee(req.tenantId!, id);
  }

  @Post(":id/badges")
  @RequireSubscriptionWrite()
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
  @AllowSubscriptionReadOnly("security")
  @RequirePermissions(CABINET_CAPABILITY.OPERATIONS_WRITE)
  async revokeBadge(
    @Req() req: RequestWithTenant,
    @Param("id") id: string,
    @Param("badgeId") badgeId: string,
  ): Promise<void> {
    return this.employeesService.revokeBadge(req.tenantId!, id, badgeId);
  }
}
