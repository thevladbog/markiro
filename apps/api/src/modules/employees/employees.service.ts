import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../../auth/auth.module";
import type {
  BadgeDto, CreateEmployeeDto, EmployeeDto, IssueBadgeDto,
  ListEmployeesQueryDto, ListEmployeesResponseDto, UpdateEmployeeDto,
} from "./dto";

@Injectable()
export class EmployeesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async listEmployees(tenantId: string, query: ListEmployeesQueryDto): Promise<ListEmployeesResponseDto> {
    const conds = [eq(schema.employees.tenantId, tenantId)];
    if (query.status) conds.push(eq(schema.employees.status, query.status));
    const rows = await this.db.select().from(schema.employees).where(and(...conds)).orderBy(schema.employees.fullName);
    const badges = await this.badgesFor(tenantId, rows.map((r) => r.id));
    return { items: rows.map((r) => this.toDto(r, badges)) };
  }

  async createEmployee(tenantId: string, dto: CreateEmployeeDto): Promise<EmployeeDto> {
    const [row] = await this.db.insert(schema.employees)
      .values({ tenantId, fullName: dto.fullName, role: dto.role ?? null }).returning();
    return this.toDto(row!, new Map());
  }

  async updateEmployee(tenantId: string, id: string, dto: UpdateEmployeeDto): Promise<EmployeeDto> {
    const set: Record<string, unknown> = {};
    if (dto.fullName !== undefined) set.fullName = dto.fullName;
    if (dto.role !== undefined) set.role = dto.role;
    if (dto.status !== undefined) set.status = dto.status;
    if (Object.keys(set).length === 0) {
      const [row] = await this.db.select().from(schema.employees)
        .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, id)));
      if (!row) throw new NotFoundException();
      return this.toDto(row, await this.badgesFor(tenantId, [id]));
    }
    const [row] = await this.db.update(schema.employees).set(set)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, id))).returning();
    if (!row) throw new NotFoundException();
    return this.toDto(row, await this.badgesFor(tenantId, [id]));
  }

  async archiveEmployee(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db.update(schema.employees).set({ status: "archived" })
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, id))).returning();
    if (!row) throw new NotFoundException();
  }

  async issueBadge(tenantId: string, employeeId: string, dto: IssueBadgeDto): Promise<EmployeeDto> {
    const [emp] = await this.db.select().from(schema.employees)
      .where(and(eq(schema.employees.tenantId, tenantId), eq(schema.employees.id, employeeId)));
    if (!emp) throw new NotFoundException();
    try {
      await this.db.insert(schema.employeeBadges).values({ tenantId, employeeId, badgeCode: dto.badgeCode, label: dto.label ?? null });
    } catch (error) {
      if ((error as { cause?: { code?: string } })?.cause?.code === "23505"
        || (error as { code?: string })?.code === "23505") {
        throw new ConflictException("Badge code already in use");
      }
      throw error;
    }
    return this.toDto(emp, await this.badgesFor(tenantId, [employeeId]));
  }

  async revokeBadge(tenantId: string, employeeId: string, badgeId: string): Promise<void> {
    const [row] = await this.db.update(schema.employeeBadges).set({ revokedAt: new Date() })
      .where(and(eq(schema.employeeBadges.tenantId, tenantId), eq(schema.employeeBadges.id, badgeId),
        eq(schema.employeeBadges.employeeId, employeeId))).returning();
    if (!row) throw new NotFoundException();
  }

  private async badgesFor(tenantId: string, ids: string[]): Promise<Map<string, BadgeDto[]>> {
    const map = new Map<string, BadgeDto[]>();
    if (ids.length === 0) return map;
    const rows = await this.db.select().from(schema.employeeBadges)
      .where(eq(schema.employeeBadges.tenantId, tenantId));
    const idSet = new Set(ids);
    for (const b of rows) {
      if (!idSet.has(b.employeeId)) continue;
      const list = map.get(b.employeeId) ?? [];
      list.push({ id: b.id, badgeCode: b.badgeCode, label: b.label, issuedAt: b.issuedAt, revokedAt: b.revokedAt });
      map.set(b.employeeId, list);
    }
    return map;
  }

  private toDto(row: typeof schema.employees.$inferSelect, badges: Map<string, BadgeDto[]>): EmployeeDto {
    return { id: row.id, fullName: row.fullName, role: row.role, status: row.status,
      badges: badges.get(row.id) ?? [], createdAt: row.createdAt };
  }
}
