import { z } from "zod";

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
