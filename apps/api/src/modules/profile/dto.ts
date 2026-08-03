import { z } from "zod";

const personName = z.string().trim().min(1).max(100);

export const updateProfileSchema = z.object({
  firstName: personName,
  lastName: personName,
  middleName: personName.nullable().optional(),
});

export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

export interface UserProfileDto {
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  hasAvatar: boolean;
}

export interface AvatarUrlDto {
  url: string | null;
}
