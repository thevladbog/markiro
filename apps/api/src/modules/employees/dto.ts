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

export const employeePickupPolicySchema = z.object({
  limitMode: z.enum(["limited", "unlimited"]),
  dayLimit: z.number().int().min(1),
  canWriteoff: z.boolean(),
});
export type UpdateEmployeePickupPolicyDto = z.infer<typeof employeePickupPolicySchema>;

const bulkEmployeeIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, "employeeIds must be unique");

export const bulkEmployeePickupLimitsSchema = z.object({
  employeeIds: bulkEmployeeIdsSchema,
  limitMode: z.enum(["limited", "unlimited"]),
  dayLimit: z.number().int().min(1),
});
export type BulkEmployeePickupLimitsDto = z.infer<typeof bulkEmployeePickupLimitsSchema>;

export const bulkEmployeePickupWriteoffSchema = z.object({
  employeeIds: bulkEmployeeIdsSchema,
  canWriteoff: z.boolean(),
});
export type BulkEmployeePickupWriteoffDto = z.infer<typeof bulkEmployeePickupWriteoffSchema>;

export const issueBadgeSchema = z.object({
  badgeCode: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(64).nullable().optional(),
});
export type IssueBadgeDto = z.infer<typeof issueBadgeSchema>;

export interface BadgeDto {
  id: string;
  badgeCode: string;
  label: string | null;
  issuedAt: Date;
  revokedAt: Date | null;
}
export interface EmployeePickupPolicyDto {
  limitMode: "limited" | "unlimited";
  dayLimit: number;
  canWriteoff: boolean;
}
export interface BulkEmployeePickupPolicyItemDto extends EmployeePickupPolicyDto {
  employeeId: string;
}
export interface BulkEmployeePickupPolicyResponseDto {
  items: BulkEmployeePickupPolicyItemDto[];
}
export interface EmployeeDto {
  id: string;
  fullName: string;
  role: string | null;
  status: "active" | "archived";
  pickupPolicy: EmployeePickupPolicyDto;
  badges: BadgeDto[];
  createdAt: Date;
}
export interface ListEmployeesResponseDto {
  items: EmployeeDto[];
}
