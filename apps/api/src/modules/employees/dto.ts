import { z } from "zod";

export const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(120).nullable().optional(),
});
export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(120).nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;

export const listEmployeesQuerySchema = z.object({
  status: z.enum(["active", "archived"]).optional(),
});
export type ListEmployeesQueryDto = z.infer<typeof listEmployeesQuerySchema>;

export const issueBadgeSchema = z.object({
  badgeCode: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(64).nullable().optional(),
});
export type IssueBadgeDto = z.infer<typeof issueBadgeSchema>;

export interface BadgeDto { id: string; badgeCode: string; label: string | null; issuedAt: Date; revokedAt: Date | null; }
export interface EmployeeDto { id: string; fullName: string; role: string | null; status: "active" | "archived"; badges: BadgeDto[]; createdAt: Date; }
export interface ListEmployeesResponseDto { items: EmployeeDto[]; }
