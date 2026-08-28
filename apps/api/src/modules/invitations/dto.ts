import { z } from "zod";

import type { SchemaObject } from "@nestjs/swagger";

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

export const publicInvitationOpenApiSchema: SchemaObject = {
  type: "object",
  additionalProperties: false,
  required: ["id", "email", "organizationName", "role", "state", "expiresAt", "hasAccount"],
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    organizationName: {
      type: "string",
      description: "Masked: only the first character is revealed.",
    },
    role: { type: "string" },
    state: { type: "string", enum: ["pending"] },
    expiresAt: { type: "string", format: "date-time" },
    hasAccount: {
      type: "boolean",
      description: "Whether an account already exists for the invited email.",
    },
  },
};

/**
 * `POST /invitations/:id/register` forwards Better Auth's sign-up response
 * verbatim (the session cookie arrives via Set-Cookie), so only the stable
 * top-level fields are documented.
 */
export const registerInvitationResponseOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["user"],
  properties: {
    token: { type: "string", nullable: true },
    user: { type: "object", additionalProperties: true },
  },
};

/**
 * Accept forwards Better Auth's acceptInvitation response verbatim; reject
 * builds the same `{ invitation, member }` shape with `member: null`.
 */
export const invitationMembershipResponseOpenApiSchema: SchemaObject = {
  type: "object",
  required: ["invitation", "member"],
  properties: {
    invitation: { type: "object", additionalProperties: true },
    member: { type: "object", additionalProperties: true, nullable: true },
  },
};
