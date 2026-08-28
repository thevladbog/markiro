import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

export const assignableTeamRoleSchema = z.enum(["admin", "manager"]);
export type AssignableTeamRoleDto = z.infer<typeof assignableTeamRoleSchema>;

const nullablePosition = z.string().trim().min(1).max(120).nullable().optional();

export const createTeamInvitationSchema = z.object({
  email: z
    .string()
    .trim()
    .pipe(z.email())
    .transform((value) => value.toLowerCase()),
  role: assignableTeamRoleSchema,
  position: nullablePosition,
  employeeId: z.uuid().nullable().optional(),
});
export type CreateTeamInvitationDto = z.infer<typeof createTeamInvitationSchema>;

export const updateTeamMemberSchema = z
  .object({
    role: assignableTeamRoleSchema.optional(),
    position: nullablePosition,
  })
  .refine((value) => value.role !== undefined || value.position !== undefined, {
    message: "role or position is required",
  });
export type UpdateTeamMemberDto = z.infer<typeof updateTeamMemberSchema>;

export const linkTeamEmployeeSchema = z.object({ employeeId: z.uuid() });
export type LinkTeamEmployeeDto = z.infer<typeof linkTeamEmployeeSchema>;

export interface TeamEmployeeDto {
  id: string;
  fullName: string;
  status: "active" | "archived";
  operatorAccess: boolean;
}

export interface TeamMemberDto {
  id: string;
  userId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  avatarAssetId: string | null;
  role: string;
  position: string | null;
  employee: TeamEmployeeDto | null;
  createdAt: Date;
}

export interface TeamInvitationDto {
  id: string;
  email: string;
  role: string | null;
  position: string | null;
  accessStatus: string;
  expiresAt: Date;
  employee: TeamEmployeeDto | null;
  delivery: { id: string; status: string; errorCategory: string | null } | null;
}

export interface TeamResponseDto {
  members: TeamMemberDto[];
  invitations: TeamInvitationDto[];
}

const uuidSchema = { type: "string", format: "uuid" } as const;
const dateTimeSchema = { type: "string", format: "date-time" } as const;

const teamEmployeeOpenApiSchema: SchemaObject = {
  type: "object",
  nullable: true,
  additionalProperties: false,
  required: ["id", "fullName", "status", "operatorAccess"],
  properties: {
    id: uuidSchema,
    fullName: { type: "string" },
    status: { type: "string", enum: ["active", "archived"] },
    operatorAccess: { type: "boolean" },
  },
};

export const teamMemberOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "userId",
    "email",
    "firstName",
    "lastName",
    "middleName",
    "avatarAssetId",
    "role",
    "position",
    "employee",
    "createdAt",
  ],
  properties: {
    id: { type: "string", description: "Opaque better-auth member id, not a UUID." },
    userId: { type: "string" },
    email: { type: "string", format: "email" },
    firstName: { type: "string", nullable: true },
    lastName: { type: "string", nullable: true },
    middleName: { type: "string", nullable: true },
    avatarAssetId: { ...uuidSchema, nullable: true },
    role: { type: "string" },
    position: { type: "string", nullable: true },
    employee: teamEmployeeOpenApiSchema,
    createdAt: dateTimeSchema,
  },
};

export const teamInvitationOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "email",
    "role",
    "position",
    "accessStatus",
    "expiresAt",
    "employee",
    "delivery",
  ],
  properties: {
    id: uuidSchema,
    email: { type: "string", format: "email" },
    role: { type: "string", nullable: true },
    position: { type: "string", nullable: true },
    accessStatus: { type: "string" },
    expiresAt: dateTimeSchema,
    employee: teamEmployeeOpenApiSchema,
    delivery: {
      type: "object",
      nullable: true,
      additionalProperties: false,
      required: ["id", "status", "errorCategory"],
      properties: {
        id: uuidSchema,
        status: { type: "string" },
        errorCategory: { type: "string", nullable: true },
      },
    },
  },
};

export const teamResponseOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["members", "invitations"],
  properties: {
    members: { type: "array", items: teamMemberOpenApiSchema },
    invitations: { type: "array", items: teamInvitationOpenApiSchema },
  },
};
