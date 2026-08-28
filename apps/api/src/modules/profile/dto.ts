import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

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

export const userProfileOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["firstName", "lastName", "middleName", "hasAvatar"],
  properties: {
    firstName: { type: "string", nullable: true },
    lastName: { type: "string", nullable: true },
    middleName: { type: "string", nullable: true },
    hasAvatar: { type: "boolean" },
  },
};

export const avatarUrlOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: {
      type: "string",
      format: "uri",
      nullable: true,
      description: "Presigned read URL valid for 300 seconds, or null when no avatar is set.",
    },
  },
};
