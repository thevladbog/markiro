import {
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  BadgeDto,
  BulkEmployeePickupLimitsDto,
  BulkEmployeePickupPolicyResponseDto,
  BulkEmployeePickupWriteoffDto,
  CreateEmployeeDto,
  EmployeeDto,
  EmployeePickupPolicyDto,
  IssueBadgeDto,
  ListEmployeesQueryDto,
  ListEmployeesResponseDto,
  ListLinkableMembersResponseDto,
  UpdateEmployeeDto,
  UpdateEmployeePickupPolicyDto,
} from "./dto";

@Injectable()
export class EmployeesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listEmployees(
    tenantId: string,
    query: ListEmployeesQueryDto,
  ): Promise<ListEmployeesResponseDto> {
    const conds = [eq(schema.employees.tenantId, tenantId)];
    if (query.status) conds.push(eq(schema.employees.status, query.status));
    const rows = await this.db
      .select({ employee: schema.employees, pickupPolicy: schema.employeePickupPolicies })
      .from(schema.employees)
      .leftJoin(
        schema.employeePickupPolicies,
        and(
          eq(schema.employeePickupPolicies.tenantId, schema.employees.tenantId),
          eq(schema.employeePickupPolicies.employeeId, schema.employees.id),
        ),
      )
      .where(and(...conds))
      .orderBy(schema.employees.fullName);
    const badges = await this.badgesFor(
      tenantId,
      rows.map((r) => r.employee.id),
    );
    return { items: rows.map((r) => this.toDto(r.employee, badges, r.pickupPolicy)) };
  }

  async listLinkableMembers(tenantId: string): Promise<ListLinkableMembersResponseDto> {
    const items = await this.db
      .select({
        memberId: schema.member.id,
        email: schema.user.email,
        firstName: schema.userProfiles.firstName,
        lastName: schema.userProfiles.lastName,
        middleName: schema.userProfiles.middleName,
        position: schema.tenantMemberProfiles.position,
      })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .leftJoin(schema.userProfiles, eq(schema.userProfiles.userId, schema.member.userId))
      .leftJoin(
        schema.tenantMemberProfiles,
        and(
          eq(schema.tenantMemberProfiles.organizationId, tenantId),
          eq(schema.tenantMemberProfiles.memberId, schema.member.id),
        ),
      )
      .leftJoin(
        schema.cabinetEmployeeLinks,
        and(
          eq(schema.cabinetEmployeeLinks.organizationId, tenantId),
          eq(schema.cabinetEmployeeLinks.memberId, schema.member.id),
        ),
      )
      .where(
        and(eq(schema.member.organizationId, tenantId), isNull(schema.cabinetEmployeeLinks.id)),
      )
      .orderBy(schema.user.email);
    return { items };
  }

  async createEmployee(
    tenantId: string,
    actorUserId: string,
    dto: CreateEmployeeDto,
  ): Promise<EmployeeDto> {
    try {
      return await this.db.transaction(async (tx) => {
        if (dto.memberId) {
          const [target] = await tx
            .select({ id: schema.member.id })
            .from(schema.member)
            .where(
              and(eq(schema.member.organizationId, tenantId), eq(schema.member.id, dto.memberId)),
            );
          if (!target) throw new NotFoundException("Member not found");
        }
        const [row] = await tx
          .insert(schema.employees)
          .values({ tenantId, fullName: dto.fullName, role: dto.role ?? null })
          .returning();
        if (!row) throw new InternalServerErrorException("Failed to create employee");
        const [pickupPolicy] = await tx
          .insert(schema.employeePickupPolicies)
          .values({ tenantId, employeeId: row.id })
          .returning();
        if (!pickupPolicy) {
          throw new InternalServerErrorException("Failed to create employee pickup policy");
        }
        if (dto.memberId) {
          await tx.insert(schema.cabinetEmployeeLinks).values({
            organizationId: tenantId,
            memberId: dto.memberId,
            employeeId: row.id,
          });
          // Same audit action as the Team-page link flow (`TeamService.linkEmployee`).
          await tx.insert(schema.tenantAuditEvents).values({
            organizationId: tenantId,
            actorUserId,
            action: "team.member.employee_linked",
            outcome: "success",
            targetType: "member",
            targetId: dto.memberId,
            after: { employeeId: row.id },
          });
        }
        return this.toDto(row, new Map(), pickupPolicy);
      });
    } catch (error) {
      if (
        (error as { cause?: { code?: string } })?.cause?.code === "23505" ||
        (error as { code?: string })?.code === "23505"
      ) {
        throw new ConflictException("Member is already linked to an employee");
      }
      throw error;
    }
  }

  async updateEmployee(tenantId: string, id: string, dto: UpdateEmployeeDto): Promise<EmployeeDto> {
    const set: Record<string, unknown> = {};
    if (dto.fullName !== undefined) set.fullName = dto.fullName;
    if (dto.role !== undefined) set.role = dto.role;
    if (dto.status !== undefined) set.status = dto.status;
    if (Object.keys(set).length === 0) {
      return this.getEmployee(tenantId, id);
    }
    await this.getEmployee(tenantId, id);
    const [row] = await this.db
      .update(schema.employees)
      .set(set)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, id)))
      .returning();
    if (!row) throw new NotFoundException();
    return this.getEmployee(tenantId, id);
  }

  async updatePickupPolicy(
    tenantId: string,
    actorUserId: string,
    employeeId: string,
    dto: UpdateEmployeePickupPolicyDto,
  ): Promise<EmployeeDto> {
    await this.db.transaction(async (tx) => {
      const [employee] = await tx
        .select({ id: schema.employees.id })
        .from(schema.employees)
        .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, employeeId)))
        .for("update");
      if (!employee) throw new NotFoundException();

      const [policy] = await tx
        .select()
        .from(schema.employeePickupPolicies)
        .where(
          and(
            eq(schema.employeePickupPolicies.tenantId, tenantId),
            eq(schema.employeePickupPolicies.employeeId, employeeId),
          ),
        )
        .for("update");
      if (!policy) {
        throw new InternalServerErrorException("Employee pickup policy is not configured");
      }
      const before = this.toPickupPolicyDto(policy);
      const after: EmployeePickupPolicyDto = dto;
      await tx
        .update(schema.employeePickupPolicies)
        .set({ ...after, updatedAt: new Date() })
        .where(
          and(
            eq(schema.employeePickupPolicies.tenantId, tenantId),
            eq(schema.employeePickupPolicies.employeeId, employeeId),
          ),
        );
      await this.insertPickupPolicyAudit(tx, tenantId, actorUserId, employeeId, before, after);
    });
    return this.getEmployee(tenantId, employeeId);
  }

  async bulkUpdatePickupLimits(
    tenantId: string,
    actorUserId: string,
    dto: BulkEmployeePickupLimitsDto,
  ): Promise<BulkEmployeePickupPolicyResponseDto> {
    return this.bulkUpdatePickupPolicies(tenantId, actorUserId, dto.employeeIds, (before) => ({
      limitMode: dto.limitMode,
      dayLimit: dto.dayLimit,
      canWriteoff: before.canWriteoff,
    }));
  }

  async bulkUpdatePickupWriteoff(
    tenantId: string,
    actorUserId: string,
    dto: BulkEmployeePickupWriteoffDto,
  ): Promise<BulkEmployeePickupPolicyResponseDto> {
    return this.bulkUpdatePickupPolicies(tenantId, actorUserId, dto.employeeIds, (before) => ({
      limitMode: before.limitMode,
      dayLimit: before.dayLimit,
      canWriteoff: dto.canWriteoff,
    }));
  }

  async archiveEmployee(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db
      .update(schema.employees)
      .set({ status: "archived" })
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, id)))
      .returning();
    if (!row) throw new NotFoundException();
  }

  async issueBadge(tenantId: string, employeeId: string, dto: IssueBadgeDto): Promise<EmployeeDto> {
    await this.getEmployee(tenantId, employeeId);
    try {
      await this.db
        .insert(schema.employeeBadges)
        .values({ tenantId, employeeId, badgeCode: dto.badgeCode, label: dto.label ?? null });
    } catch (error) {
      if (
        (error as { cause?: { code?: string } })?.cause?.code === "23505" ||
        (error as { code?: string })?.code === "23505"
      ) {
        throw new ConflictException("Badge code already in use");
      }
      throw error;
    }
    return this.getEmployee(tenantId, employeeId);
  }

  async revokeBadge(tenantId: string, employeeId: string, badgeId: string): Promise<void> {
    const [row] = await this.db
      .update(schema.employeeBadges)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.employeeBadges.tenantId, tenantId),
          eq(schema.employeeBadges.id, badgeId),
          eq(schema.employeeBadges.employeeId, employeeId),
          isNull(schema.employeeBadges.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException();
  }

  private async badgesFor(tenantId: string, ids: string[]): Promise<Map<string, BadgeDto[]>> {
    const map = new Map<string, BadgeDto[]>();
    if (ids.length === 0) return map;
    const rows = await this.db
      .select()
      .from(schema.employeeBadges)
      .where(eq(schema.employeeBadges.tenantId, tenantId));
    const idSet = new Set(ids);
    for (const b of rows) {
      if (!idSet.has(b.employeeId)) continue;
      const list = map.get(b.employeeId) ?? [];
      list.push({
        id: b.id,
        badgeCode: b.badgeCode,
        label: b.label,
        issuedAt: b.issuedAt,
        revokedAt: b.revokedAt,
      });
      map.set(b.employeeId, list);
    }
    return map;
  }

  private async getEmployee(tenantId: string, employeeId: string): Promise<EmployeeDto> {
    const [row] = await this.db
      .select({ employee: schema.employees, pickupPolicy: schema.employeePickupPolicies })
      .from(schema.employees)
      .leftJoin(
        schema.employeePickupPolicies,
        and(
          eq(schema.employeePickupPolicies.tenantId, schema.employees.tenantId),
          eq(schema.employeePickupPolicies.employeeId, schema.employees.id),
        ),
      )
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, employeeId)));
    if (!row) throw new NotFoundException();
    return this.toDto(row.employee, await this.badgesFor(tenantId, [employeeId]), row.pickupPolicy);
  }

  private async bulkUpdatePickupPolicies(
    tenantId: string,
    actorUserId: string,
    employeeIds: string[],
    update: (before: EmployeePickupPolicyDto) => EmployeePickupPolicyDto,
  ): Promise<BulkEmployeePickupPolicyResponseDto> {
    return this.db.transaction(async (tx) => {
      const employees = await tx
        .select({ id: schema.employees.id })
        .from(schema.employees)
        .where(
          and(eq(schema.employees.tenantId, tenantId), inArray(schema.employees.id, employeeIds)),
        )
        .orderBy(schema.employees.id)
        .for("update");
      if (employees.length !== employeeIds.length) throw new NotFoundException();

      const policies = await tx
        .select()
        .from(schema.employeePickupPolicies)
        .where(
          and(
            eq(schema.employeePickupPolicies.tenantId, tenantId),
            inArray(schema.employeePickupPolicies.employeeId, employeeIds),
          ),
        )
        .orderBy(schema.employeePickupPolicies.employeeId)
        .for("update");
      if (policies.length !== employeeIds.length) {
        throw new InternalServerErrorException("Employee pickup policy is not configured");
      }
      const policiesByEmployee = new Map(policies.map((policy) => [policy.employeeId, policy]));
      const items: BulkEmployeePickupPolicyResponseDto["items"] = [];
      for (const employeeId of employeeIds) {
        const policy = policiesByEmployee.get(employeeId);
        if (!policy) {
          throw new InternalServerErrorException("Employee pickup policy is not configured");
        }
        const before = this.toPickupPolicyDto(policy);
        const after = update(before);
        await tx
          .update(schema.employeePickupPolicies)
          .set({ ...after, updatedAt: new Date() })
          .where(
            and(
              eq(schema.employeePickupPolicies.tenantId, tenantId),
              eq(schema.employeePickupPolicies.employeeId, employeeId),
            ),
          );
        await this.insertPickupPolicyAudit(tx, tenantId, actorUserId, employeeId, before, after);
        items.push({ employeeId, ...after });
      }
      return { items };
    });
  }

  private async insertPickupPolicyAudit(
    tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
    tenantId: string,
    actorUserId: string,
    employeeId: string,
    before: EmployeePickupPolicyDto,
    after: EmployeePickupPolicyDto,
  ): Promise<void> {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId,
      action: "employee.pickup_policy.updated",
      outcome: "success",
      targetType: "employee",
      targetId: employeeId,
      before,
      after,
    });
  }

  private toPickupPolicyDto(
    policy: typeof schema.employeePickupPolicies.$inferSelect,
  ): EmployeePickupPolicyDto {
    return {
      limitMode: policy.limitMode,
      dayLimit: policy.dayLimit,
      canWriteoff: policy.canWriteoff,
    };
  }

  private toDto(
    row: typeof schema.employees.$inferSelect,
    badges: Map<string, BadgeDto[]>,
    pickupPolicy: typeof schema.employeePickupPolicies.$inferSelect | null,
  ): EmployeeDto {
    if (!pickupPolicy) {
      throw new InternalServerErrorException("Employee pickup policy is not configured");
    }
    return {
      id: row.id,
      fullName: row.fullName,
      role: row.role,
      status: row.status,
      pickupPolicy: this.toPickupPolicyDto(pickupPolicy),
      badges: badges.get(row.id) ?? [],
      createdAt: row.createdAt,
    };
  }
}
