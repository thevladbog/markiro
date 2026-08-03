import { z } from "zod";

const personName = z.string().trim().min(1).max(100);

export const registerInvitationSchema = z.object({
  firstName: personName,
  lastName: personName,
  middleName: personName.nullable().optional(),
  password: z.string().min(8).max(128),
});
export type RegisterInvitationDto = z.infer<typeof registerInvitationSchema>;

export interface PublicInvitationDto {
  id: string;
  email: string;
  organizationName: string;
  role: string;
  state: "pending";
  expiresAt: Date;
  hasAccount: boolean;
}
