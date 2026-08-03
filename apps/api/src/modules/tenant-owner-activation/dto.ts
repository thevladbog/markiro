import { z } from "zod";

export const activationTokenSchema = z.object({ token: z.string().min(16).max(512) });
export const completeTenantOwnerActivationSchema = activationTokenSchema.extend({
  password: z.string().min(8).max(128).optional(),
});

export type ActivationTokenDto = z.infer<typeof activationTokenSchema>;
export type CompleteTenantOwnerActivationDto = z.infer<typeof completeTenantOwnerActivationSchema>;

export interface TenantOwnerActivationStatusDto {
  hasAccount: boolean;
}
