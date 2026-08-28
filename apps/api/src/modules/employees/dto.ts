import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

export const createEmployeeSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(120).nullable().optional(),
  // better-auth member ids are opaque text, not UUIDs.
  memberId: z.string().trim().min(1).max(255).nullable().optional(),
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
  .array(
    z
      .string()
      .uuid()
      .transform((employeeId) => employeeId.toLowerCase()),
  )
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

/** A cabinet member without a linked employee — a candidate for the create-employee picker. */
export interface LinkableMemberDto {
  memberId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  position: string | null;
}
export interface ListLinkableMembersResponseDto {
  items: LinkableMemberDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

const badgeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "badgeCode", "label", "issuedAt", "revokedAt"],
  properties: {
    id: uuidSchema,
    badgeCode: { type: "string" },
    label: { type: "string", nullable: true },
    issuedAt: dateTimeSchema,
    revokedAt: { ...dateTimeSchema, nullable: true },
  },
};

const employeePickupPolicyOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["limitMode", "dayLimit", "canWriteoff"],
  properties: {
    limitMode: { type: "string", enum: ["limited", "unlimited"] },
    dayLimit: { type: "integer", minimum: 1 },
    canWriteoff: { type: "boolean" },
  },
};

export const employeeOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "fullName", "role", "status", "pickupPolicy", "badges", "createdAt"],
  properties: {
    id: uuidSchema,
    fullName: { type: "string" },
    role: { type: "string", nullable: true },
    status: { type: "string", enum: ["active", "archived"] },
    pickupPolicy: employeePickupPolicyOpenApiSchema,
    badges: { type: "array", items: badgeOpenApiSchema },
    createdAt: dateTimeSchema,
  },
};

export const listEmployeesOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items: employeeOpenApiSchema } },
};

export const listLinkableMembersOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["memberId", "email", "firstName", "lastName", "middleName", "position"],
        properties: {
          memberId: {
            type: "string",
            description: "Opaque better-auth member id, not a UUID.",
          },
          email: { type: "string", format: "email" },
          firstName: { type: "string", nullable: true },
          lastName: { type: "string", nullable: true },
          middleName: { type: "string", nullable: true },
          position: { type: "string", nullable: true },
        },
      },
    },
  },
};

export const bulkEmployeePickupPolicyResponseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["employeeId", "limitMode", "dayLimit", "canWriteoff"],
        properties: {
          employeeId: uuidSchema,
          ...employeePickupPolicyOpenApiSchema.properties,
        },
      },
    },
  },
};
